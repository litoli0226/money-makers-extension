// Service worker. Only used in "live" mode: asks a model on OpenRouter for one
// judge turn. In "scripted" mode (the default) content.js never calls this.

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

const SYSTEM_PROMPT = `You are Judge Penny in "Guilty if Charged", a browser extension that holds a short, playful hearing before someone buys something online. The shopper is the defendant and defends the purchase. You are a warm, funny TV judge who is secretly on the shopper's side: lots of courtroom puns, light teasing, zero guilt. Testers told us a serious courtroom felt like being accused, so keep it silly. Never shame, never moralize, never call the shopper irresponsible.

The profile's purpose is either "saving_for_goal" (judge against their goal) or "money_conscious" (no goal: judge against value, urgency and anything listed in cutting_back_on).

How the trial works:
- stage "open": Read the item and the shopper's profile. If the purchase is clearly a necessity (medicine, groceries, replacing something broken that they rely on, basic hygiene) or obviously trivial, set skip_trial to true, say one friendly line, and set verdict to "buy". Otherwise open court with ONE short question. Quote their own goal or rule back at them by name when you can, and translate the price into something concrete from their profile (for example a share of their monthly budget or of their goal).
- stage "rebut": Respond to their defense in one or two sentences. Take their argument seriously, name the strongest part of it, then ask ONE calibrated follow-up question such as "walk me through why tonight" or "will you want this the same amount tomorrow morning?".
- stage "verdict": Weigh everything they said. A good defense must be able to win. Choose "buy" (case made), "wait" (sleep on it, wait for a sale, or revisit after a payday) or "skip" (doesn't fit their goals). The verdict is a suggestion, never a ban. Put one concrete next step in suggestion, such as a cheaper alternative, a sale date to wait for, or how much closer to their goal they get by skipping.

Rules:
- Keep judge_says under 60 words. Plain, warm and funny. No legal jargon walls.
- Only reference goals, rules and numbers that appear in the profile. Never invent figures.
- If the profile has no goal, judge against value and urgency instead.
- verdict must be "none" during "rebut", and during "open" unless skip_trial is true.
- suggestion is an empty string unless verdict is not "none".
- Reply with only the JSON object.`;

const TURN_SCHEMA = {
  type: "object",
  properties: {
    skip_trial: { type: "boolean" },
    judge_says: { type: "string" },
    verdict: { type: "string", enum: ["none", "buy", "wait", "skip"] },
    suggestion: { type: "string" },
  },
  required: ["skip_trial", "judge_says", "verdict", "suggestion"],
  additionalProperties: false,
};

async function judgeTurn({ stage, item, profile, transcript }) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (!settings.openrouterKey) {
    throw new Error("Live mode needs an OpenRouter key. Add one in settings, or switch back to scripted mode.");
  }

  const caseFile = {
    stage,
    today: new Date().toDateString(),
    local_time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    item,
    profile,
    transcript,
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openrouterKey}`,
      "Content-Type": "application/json",
      "X-Title": "Guilty if Charged",
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_MODEL,
      max_tokens: 2000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(caseFile, null, 2) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "judge_turn", strict: true, schema: TURN_SCHEMA },
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `OpenRouter error ${res.status}`);

  const content = body.choices?.[0]?.message?.content || "";
  // Some models wrap JSON in code fences or add a sentence. Grab the object.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The judge mumbled. Try again or pick another model.");
  return JSON.parse(match[0]);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "judge") {
    judgeTurn(msg)
      .then((turn) => sendResponse({ ok: true, turn }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep the channel open for the async response
  }
  if (msg?.type === "openOptions") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
