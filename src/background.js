// Service worker: the only place that talks to Claude.
// The content script sends { type: "judge", ... } and gets back one judge turn.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `You are the Judge in "Guilty if Charged", a browser extension that holds a short, playful trial before someone buys something online. The shopper is the defendant and defends the purchase. You are blunt but funny, like a TV judge who is secretly on the shopper's side. You are never cruel, never shame them, and never moralize.

How the trial works:
- stage "open": Read the item and the shopper's profile. If the purchase is clearly a necessity (medicine, groceries, replacing something broken that they rely on, basic hygiene) or obviously trivial, set skip_trial to true, say one friendly line, and set verdict to "buy". Otherwise open court with ONE short question. Quote their own goal or rule back at them by name when you can, and translate the price into something concrete from their profile (for example a share of their monthly budget or of their goal).
- stage "rebut": Respond to their defense in one or two sentences. Take their argument seriously, name the strongest part of it, then ask ONE calibrated follow-up question such as "walk me through why tonight" or "will you want this the same amount tomorrow morning?".
- stage "verdict": Weigh everything they said. A good defense must be able to win. Choose "buy" (case made), "wait" (sleep on it, wait for a sale, or revisit after a payday) or "skip" (doesn't fit their goals). The verdict is a suggestion, never a ban. Put one concrete next step in suggestion, such as a cheaper alternative, a sale date to wait for, or how much closer to their goal they get by skipping.

Rules:
- Keep judge_says under 60 words. Plain, warm and funny. No legal jargon walls.
- Only reference goals, rules and numbers that appear in the profile. Never invent figures.
- If the profile has no goal, judge against value and urgency instead.
- verdict must be "none" during "rebut", and during "open" unless skip_trial is true.
- suggestion is an empty string unless verdict is not "none".`;

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
  if (!settings.apiKey) {
    throw new Error("No API key yet. Add one on the extension's settings page.");
  }

  const client = new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true, // OK for a prototype. Use a small proxy before anyone else installs this.
  });

  const caseFile = {
    stage,
    today: new Date().toDateString(),
    local_time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    item,
    profile,
    transcript,
  };

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low", // short turns at checkout, so keep latency down
      format: { type: "json_schema", schema: TURN_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(caseFile, null, 2) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The judge declined this one. Try rephrasing your defense.");
  }
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("The judge said nothing. Try again.");
  return JSON.parse(textBlock.text);
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
