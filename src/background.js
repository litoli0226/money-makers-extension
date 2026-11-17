// Service worker. Only used in "live" mode. Two AI characters, each its own
// call with its own persona: Prosecutor Pinch argues against the purchase,
// Judge Penny runs the hearing and rules. Returns the same shape as the
// scripted hearing in src/script.js:
//   { lines: [{ speaker, text }], skip_trial, verdict, suggestion }

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

const SHARED = `This is "Guilty if Charged", a browser extension that holds a short, playful mock hearing right before someone checks out online. The shopper is the defendant and types their defense. Testers said a serious courtroom felt like being accused, so keep it light: courtroom puns, gentle teasing, zero guilt. Never shame, never moralize, never call anyone irresponsible.

You get a case file as JSON: the item, the shopper's profile and the transcript so far. Profile purpose is "saving_for_goal" (weigh against their goal) or "money_conscious" (no goal, weigh value, urgency and anything in cutting_back_on). Only use numbers, goals and rules that appear in the case file. Never invent figures. Read the transcript carefully and respond to what the defendant actually said, quoting a few of their words when it helps. Reply with only the JSON object.`;

const PROSECUTOR_PROMPT = `${SHARED}

You are Prosecutor Pinch, a dramatic but lovable prosecutor who argues against the purchase. You speak in one or two short sentences (under 45 words).
- stage "open": Present the charges. Name the item and price, and one concrete fact from the profile (share of budget, share of goal, time of day). If the item is plainly a cheap necessity (medicine, sleep aids, hygiene, groceries, replacing something broken), concede that you have no case instead.
- stage "rebut": Cross-examine. Take their latest defense seriously, find its weak spot, and ask ONE pointed but friendly question (cheaper alternative? would they pay full price? will they use it in a month?). If their defense is a real need, acknowledge it and only ask about price or alternatives.
- stage "verdict": Give a one-sentence closing. If the defense was genuinely strong, gracefully admit it.`;

const JUDGE_PROMPT = `${SHARED}

You are Judge Penny, a warm, funny TV judge who is secretly on the shopper's side. You speak in one or two short sentences (under 45 words). The prosecutor's line for this stage is already in the transcript.
- stage "open": If the prosecutor conceded or the item is plainly a cheap necessity, set skip_trial true, dismiss the case kindly and set verdict "buy". Otherwise invite the defendant to explain, tying in the time or their profile.
- stage "verdict": Weigh both sides fairly. A real need or a strong argument must be able to win. Pick "buy" (case made), "wait" (cooling-off, wait for a sale or payday) or "skip" (doesn't fit their goals or budget). Reference what the defendant said. Put one concrete, proportionate next step in suggestion (no sale-date advice for cheap items). The ruling is advice, never a ban.
- verdict must be "none" and suggestion "" unless you are ruling or dismissing.`;

const PROSECUTOR_SCHEMA = {
  type: "object",
  properties: { says: { type: "string" } },
  required: ["says"],
  additionalProperties: false,
};

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    says: { type: "string" },
    skip_trial: { type: "boolean" },
    verdict: { type: "string", enum: ["none", "buy", "wait", "skip"] },
    suggestion: { type: "string" },
  },
  required: ["says", "skip_trial", "verdict", "suggestion"],
  additionalProperties: false,
};

async function callModel(settings, systemPrompt, schema, caseFile) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openrouterKey}`,
      "Content-Type": "application/json",
      "X-Title": "Guilty if Charged",
    },
    body: JSON.stringify({
      model: settings.model || DEFAULT_MODEL,
      max_tokens: 1500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(caseFile, null, 2) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "turn", strict: true, schema } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `OpenRouter error ${res.status}`);
  const content = body.choices?.[0]?.message?.content || "";
  const match = content.match(/\{[\s\S]*\}/); // some models wrap JSON in fences
  if (!match) throw new Error("The court reporter couldn't make that out. Try again or pick another model.");
  return JSON.parse(match[0]);
}

async function hearingTurn({ stage, item, profile, transcript }) {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (!settings.openrouterKey) {
    throw new Error("Live mode needs an OpenRouter key. Add one in settings, or switch back to scripted mode.");
  }
  const caseFile = (t) => ({
    stage,
    today: new Date().toDateString(),
    local_time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    item,
    profile,
    transcript: t,
  });

  const pros = await callModel(settings, PROSECUTOR_PROMPT, PROSECUTOR_SCHEMA, caseFile(transcript));
  const lines = [{ speaker: "prosecutor", text: pros.says }];
  if (stage === "rebut") return { lines, skip_trial: false, verdict: "none", suggestion: "" };

  const withPros = [...transcript, { role: "prosecutor", text: pros.says }];
  const judge = await callModel(settings, JUDGE_PROMPT, JUDGE_SCHEMA, caseFile(withPros));
  lines.push({ speaker: "judge", text: judge.says });
  return { lines, skip_trial: judge.skip_trial, verdict: judge.verdict, suggestion: judge.suggestion };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "judge") {
    hearingTurn(msg)
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
