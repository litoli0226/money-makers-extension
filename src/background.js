// Service worker. Runs the live (AI) court and loads the Urbanist font.
//
// Live court: the judge and the expert witness are separate model calls, each
// with its own personality file in /personality. Each call returns JSON for one
// stage (same shapes as the scripted court in src/script.js). The hearing rules
// in src/flow.js decide what happens next. The model only scores and writes.
//
// Providers: OpenRouter (any model) or Anthropic directly (Claude).
//
// Branch guest-trial-mvp adds the MVP stages (mvp_*) below. Same pattern: one
// JSON reply per stage, rules in src/flow.js decide what happens next, except
// the verdict when Settings -> "C2: who picks the verdict" is set to the model.

importScripts("/src/prices.js", "/src/findings.js");

const DEFAULTS = {
  openrouter: "anthropic/claude-haiku-5.5",
  anthropic: "claude-haiku-5-5",
};

const CASE_FILE_NOTE = `You'll get a case file as JSON: the item, the shopper's profile (goal and savings, if any), the transcript so far and stage details. Only use numbers that appear in the case file. Never invent prices, sale dates or statistics. If "profile.goal" is null the shopper has no goal: say "your savings", and never make up a goal or call it a "general savings goal". Refer to the item by "item.short", not its full store title. Reply with only the JSON object.`;

const STAGES = {
  open: {
    who: "judge",
    task: `Stage: open. Write "opening": one short line that opens the hearing for this item. Write "question": the first question, asking what made them want it.`,
    schema: { opening: "string", question: "string" },
  },
  answer: {
    who: "judge",
    task: `Stage: answer. The defendant just answered ("answer" in the case file).
Write "acknowledge": a one-sentence reaction to that answer.
Score the answer in "strength":
- "strong": a concrete, real need or clearly regular use, with specifics (it broke, ran out, needed for work or school, daily use).
- "good": a reasonable case with some substance.
- "neutral": a fair point that doesn't decide anything (it's on sale, it's a gift idea).
- "weak": mostly a want, or vague.
- "impulse": clearly an impulse, a mood buy or boredom.
Set "engaged" to false if the answer is under three words, "idk", off-topic, or a joke with no reason in it. Otherwise true.
Set "unsure" to true if the answer shows confusion or debate ("maybe", "still thinking", "I guess", "trying", "not sure"). Otherwise false.
Set "claim" to the main kind of argument: need, usage, price, learn, gift, treat, want or vague.
Write "question": the question for round "next_round". Push on the weakest part of their case so far. Never repeat an earlier question. If "next_round" equals "rounds_planned", start it with "Last question."
Write questions the way a person would say them out loud: short, plain and specific to this item. Good: "Would you rather have the earbuds, or $48 more toward Spring break?" Avoid stiff phrasing like "Is it worth more to you right now than $48 toward your goal?"`,
    schema: {
      acknowledge: "string",
      strength: ["strong", "good", "neutral", "weak", "impulse"],
      engaged: "boolean",
      unsure: "boolean",
      claim: ["need", "usage", "price", "learn", "gift", "treat", "want", "vague"],
      question: "string",
    },
  },
  witness: {
    who: "witness",
    task: `Stage: witness. You are the expert witness named in "witness.name". Give your testimony in "says": two or three sentences with one useful perspective on this case. No questions.`,
    schema: { says: "string" },
  },
  after_witness: {
    who: "judge",
    task: `Stage: after_witness. The expert witness just testified (last line of the transcript). Write "question": briefly thank the witness, then ask the defendant one question that follows from the testimony.`,
    schema: { question: "string" },
  },
  verdict: {
    who: "judge",
    task: `Stage: verdict. The ruling is already decided by the hearing rules and is in "verdict": "approve" (go for it) or "save" (save it). Never contradict it. Write "reason": one line explaining the ruling, drawn from what the defendant said.
- approve: their case held up. Quote a few of their best words.
- save: the case didn't outweigh the cost. If they have a goal, say what the money does for it.`,
    schema: { reason: "string" },
  },
};


// ---------- Guest-trial MVP stages ----------

const MVP_STAGES = {
  mvp_item: {
    who: "judge",
    task: `Stage: mvp_item. The defendant just gave their title; call them by "defendant_name".
Write "line": address the defendant by "defendant_name", say they have brought before the court a purchase of the item's price, tell the joke in "joke" (your own absurdly rich past; reword lightly if you like, keep the punchline), then ask "What are you spending it on?"
Write "price_line": start by naming the price and what it is, using "item_noun" if present ("A $48 candle."). Then, if "price_match" is not null, add one dry jab built from it, addressed to the defendant by name, for example "I guess you don't like movie tickets, Mr. Moneybags, as that's 3 movie tickets." (or "half of" when price_match.half is true). Use no other prices. These stories about yourself are allowed even though you never invent facts, prices or statistics anywhere else.
Write "question": ask how the item will make their life better. Ask how, not why.`,
    schema: { line: "string", price_line: "string", question: "string" },
  },
  mvp_how: {
    who: "judge",
    task: `Stage: mvp_how. The defendant just answered your "how" question ("answer" in the case file).
Set "kind":
- "mechanism": they say how the item will be used: when, where, how often, a plan or a setup ("I'll wear them every night and set up a sleep playlist").
- "reason": they say why they want it, without how ("I need these, my roommate is loud", "it's on sale", "I deserve it").
- "unclear": too short or off-topic to tell.
Score "strength", "engaged", "unsure" and "claim" exactly as in the answer stage rubric: strength is strong, good, neutral, weak or impulse; claim is need, usage, price, learn, gift, treat, want or vague. A mechanism with specifics counts as strong or good.
If "objection_allowed" is true and kind is not "mechanism": write "objection". If kind is "reason", tell them you asked how, not why, in one sentence (for example "Not why, defendant. I asked how."). If kind is "unclear" (a non-answer such as "um", "idk", "it's nice"), don't say "not why": show you heard exactly what they wrote and that it can't go on the record (for example: "'Um' is not something the court can write down."). Either way, then ask once more, plainly, for when and where they'll use it (for a gift: when and how the person receiving it will use it). Leave "acknowledge" empty.
Otherwise: write "acknowledge": one short sentence reacting to the answer, without repeating it back. Leave "objection" empty. If "second" is true, this was their second answer: vary the acknowledgment and don't praise.
Always write "followup": one short question that pins down a number or a moment in their answer (how often, when first, for whom, what happens if they skip it). It's only shown when there was no objection. You may open it with a few dry words reacting to the answer, if they're funny; no filler like "Noted."
Set "flag" to "violent", "hateful", "sexual" or "self_harm" if the answer contains that kind of content (threats or violence toward people, slurs or hate toward a group, sexual content, thoughts of self-harm), otherwise "none".`,
    schema: {
      kind: ["mechanism", "reason", "unclear"],
      strength: ["strong", "good", "neutral", "weak", "impulse"],
      engaged: "boolean",
      unsure: "boolean",
      claim: ["need", "usage", "price", "learn", "gift", "treat", "want", "vague"],
      acknowledge: "string",
      objection: "string",
      followup: "string",
      flag: ["none", "violent", "hateful", "sexual", "self_harm"],
    },
  },
  mvp_charge: {
    who: "judge",
    task: `Stage: mvp_charge. You are calling the expert witness in "witness" (name and role) to the stand. Ask the witness one question, one sentence, beginning "Witness," that quotes a few words the defendant said (their most recent answer) and asks what the research or the math says about it. Example: Witness, the defendant says "it's for my girlfriend's birthday." What does the research say? Don't hint at what the witness will say.`,
    schema: { question: "string" },
  },
  mvp_witness: {
    who: "witness",
    task: `Stage: witness. You are the witness named in "witness.name" ("witness.role" says who you are; "The item itself" speaks as the item, "Your wallet" as the defendant's wallet). The judge just asked you "charge". Answer it in "says": one or two short sentences, dry and specific, no questions.
Give information (a figure, a finding, cost-per-use math from what the defendant said); never tell the judge or the defendant what to ask or do. Take the side in "witness.stance": "for" means your answer leans toward the purchase, "against" means it leans against it. Never say which side you're on.
If "witness.id" is "research": quote one finding from "findings" in the case file, in plain words, and set "finding_id" to its id. Pick the finding that fits the stance when you can. No numbers beyond the finding's.
Otherwise set "finding_id" to "none" (simple arithmetic from the case file is fine).`,
    schema: { says: "string", finding_id: "string" },
  },
  mvp_respond: {
    who: "judge",
    task: `Stage: mvp_respond. The defendant just answered the judge ("question" and "answer" in the case file; "step" says which question).
Score "strength", "engaged", "unsure" and "claim" as in the answer stage rubric, with these steps:
- "advocacy" (what they'd tell a friend in the same spot): advice to wait, skip or think it over is "weak" (it argues against their own purchase); advice to go ahead, with a reason, is "good".
- "closing" (the judge said where the court leans and asked what should change its mind): score as a normal answer.
Leave "acknowledge" empty (the court goes straight to deliberation).
Set "flag" as in mvp_how: "violent", "hateful", "sexual", "self_harm" or "none".`,
    schema: {
      strength: ["strong", "good", "neutral", "weak", "impulse"],
      engaged: "boolean",
      unsure: "boolean",
      claim: ["need", "usage", "price", "learn", "gift", "treat", "want", "vague"],
      acknowledge: "string",
      flag: ["none", "violent", "hateful", "sexual", "self_harm"],
    },
  },
  gift_check: {
    who: "judge",
    task: `Stage: gift_check. The defendant mentioned a gift. Write "question": one or two sentences that say a gift changes the verdict, and ask them to confirm. Two buttons will appear under it: "It's a gift" and "It's not a gift".`,
    schema: { question: "string" },
  },
  mvp_verdict: {
    who: "judge",
    task: `Stage: mvp_verdict. Write "reason": one line explaining the ruling, drawn from what the defendant said. When the case held up, quote a few words of their "how" (the plan for using it), not their reason for wanting it. When the ruling is sleep or denied and "advice" is set (what they said they'd tell a friend), turn that advice back on them ("You'd tell a friend to wait.") and say the court is taking it.
If "verdict_by" is "rule", the ruling is already in "verdict" (approve, sleep or denied); never contradict it.
If "verdict_by" is "model", pick "verdict" yourself: "approve" when they gave a concrete plan for using it, "denied" when it was clearly an impulse, "sleep" otherwise. When unsure, pick "sleep".
Write "signup": one or two sentences inviting them to set a savings goal for next time, so the court can hold them accountable. Personalize it from this trial: name the item and its price, or refer to their plan without repeating the quote already in "reason" (for a gift: gifts add up; for sleep: weigh the item against the goal; for denied: the money is still theirs). Don't say "sign up" or ask for an email. A "Set my goal" button appears under it.`,
    schema: { verdict: ["approve", "sleep", "denied"], reason: "string", signup: "string" },
  },
};
Object.assign(STAGES, MVP_STAGES);
STAGES.mvp_respond_q = STAGES.after_witness;
// The closing question is written by the code (MVP_LINES.closing), in both modes. // same job: thank the witness, ask the defendant to respond

// Turn the shorthand above into a JSON schema.
function jsonSchema(shape) {
  const properties = {};
  for (const [k, v] of Object.entries(shape)) {
    properties[k] = Array.isArray(v) ? { type: "string", enum: v } : { type: v };
  }
  return { type: "object", properties, required: Object.keys(shape), additionalProperties: false };
}

// personality/<who>.md is the character brief. personality/example-trials.md
// holds sample hearings the team wrote, used as a style reference.
const files = {};
async function readFile(path) {
  if (!(path in files)) {
    const res = await fetch(chrome.runtime.getURL(path));
    files[path] = res.ok ? await res.text() : "";
  }
  return files[path];
}
async function personality(who, format) {
  const brief = await readFile(`personality/${who}.md`);
  const examples = await readFile(format === "mvp" ? "personality/example-trials-mvp.md" : "personality/example-trials.md");
  if (!examples.trim()) return brief;
  return `${brief}

---

# Example trials (style reference)

These are sample hearings the team wrote to show the tone, pacing and length to aim for. Match their voice, not their facts: never reuse their items, prices or quotes, and follow the stage instructions below even when an example does something different.

${examples}`;
}

async function callOpenRouter(settings, system, schema, caseFile) {
  if (!settings.openrouterKey) throw new Error("Add an OpenRouter key in Settings, or switch to scripted mode.");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openrouterKey}`,
      "Content-Type": "application/json",
      "X-Title": "Guilty If Charged",
    },
    body: JSON.stringify({
      model: settings.openrouterModel || DEFAULTS.openrouter,
      max_tokens: 1500,
      // MVP switch R11/R16: lower = steadier. Empty in Settings = the provider's default.
      ...(settings.temperature !== undefined && settings.temperature !== "" ? { temperature: Number(settings.temperature) } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(caseFile, null, 2) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "turn", strict: true, schema } },
      // Only hosts that don't store prompts or train on them, unless a tester
      // switches this to "allow" in Settings. Matches privacy.html.
      provider: { data_collection: settings.aiDataPolicy === "allow" ? "allow" : "deny" },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `OpenRouter error ${res.status}`);
  return body.choices?.[0]?.message?.content || "";
}

async function callAnthropic(settings, system, schema, caseFile) {
  if (!settings.anthropicKey) throw new Error("Add an Anthropic API key in Settings, or switch to scripted mode.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.anthropicKey,
      "anthropic-version": "2026-10-21",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.anthropicModel || DEFAULTS.anthropic,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: JSON.stringify(caseFile, null, 2) }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Anthropic error ${res.status}`);
  if (body.stop_reason === "refusal") throw new Error("The model declined this one.");
  if (body.stop_reason === "max_tokens") throw new Error("The model ran out of room. Try again.");
  return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function courtTurn({ stage, ctx }) {
  const spec = STAGES[stage];
  if (!spec) throw new Error(`Unknown stage ${stage}`);
  const { settings = {} } = await chrome.storage.local.get("settings");
  const format = stage.startsWith("mvp_") || stage === "gift_check" ? "mvp" : "classic";
  const system = `${await personality(spec.who, format)}\n\n---\n\n${CASE_FILE_NOTE}\n\n${spec.task}`;
  const caseFile = {
    stage,
    today: new Date().toDateString(),
    local_time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    ...ctx,
  };
  if (stage === "mvp_item") {
    const P = globalThis.gicPrices;
    caseFile.price_match = P.comparePrice(ctx.item?.total);
    caseFile.item_noun = P.itemNoun(ctx.item?.label);
    caseFile.joke = ctx.joke; // picked at random by the content script, so variety doesn't depend on temperature
  }
  if (stage === "mvp_witness") caseFile.findings = globalThis.gicFindings.FINDINGS.map(({ id, line, cite }) => ({ id, line, cite }));
  const schema = jsonSchema(spec.schema);
  const call = settings.mode === "anthropic" ? callAnthropic : callOpenRouter;
  const text = await call(settings, system, schema, caseFile);
  const match = text.match(/\{[\s\S]*\}/); // some models wrap JSON in code fences
  if (!match) throw new Error("The court reporter couldn't make that out.");
  return JSON.parse(match[0]);
}

// Urbanist, fetched once and handed to the content script as bytes. Shopping
// sites block outside font URLs, but a font made from bytes isn't a fetch.
async function urbanist() {
  const { fontCache } = await chrome.storage.local.get("fontCache");
  if (fontCache) return fontCache;
  const css = await (await fetch("https://fonts.googleapis.com/css2?family=Urbanist:wght@400..700&display=swap")).text();
  const latin = css.split("/* latin */")[1] || css;
  const url = latin.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
  if (!url) throw new Error("font url not found");
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  await chrome.storage.local.set({ fontCache: b64 });
  return b64;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "court") {
    courtTurn(msg)
      .then((turn) => sendResponse({ ok: true, turn }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // keep the channel open for the async response
  }
  if (msg?.type === "font") {
    urbanist()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "openOptions") chrome.runtime.openOptionsPage();
  if (msg?.type === "openPrivacy") chrome.tabs.create({ url: chrome.runtime.getURL("privacy.html") });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Older builds called OpenRouter mode "live".
  const { settings } = await chrome.storage.local.get("settings");
  if (settings?.mode === "live") await chrome.storage.local.set({ settings: { ...settings, mode: "openrouter" } });
  // Guest-trial MVP: no onboarding. A tester has the extension already and is
  // shopping; Settings opens only from the toolbar popup or chrome://extensions.
});
