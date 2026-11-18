// Service worker. Runs the live (AI) court and loads the Urbanist font.
//
// Live court: the judge and the expert witness are separate model calls, each
// with its own personality file in /personality. Each call returns JSON for one
// stage (same shapes as the scripted court in src/script.js). The hearing rules
// in src/flow.js decide what happens next. The model only scores and writes.
//
// Providers: OpenRouter (any model) or Anthropic directly (Claude).

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
async function personality(who) {
  const brief = await readFile(`personality/${who}.md`);
  const examples = await readFile("personality/example-trials.md");
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
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(caseFile, null, 2) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "turn", strict: true, schema } },
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
  const system = `${await personality(spec.who)}\n\n---\n\n${CASE_FILE_NOTE}\n\n${spec.task}`;
  const caseFile = {
    stage,
    today: new Date().toDateString(),
    local_time: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    ...ctx,
  };
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
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Older builds called OpenRouter mode "live".
  const { settings } = await chrome.storage.local.get("settings");
  if (settings?.mode === "live") await chrome.storage.local.set({ settings: { ...settings, mode: "openrouter" } });
  if (reason === "install") chrome.runtime.openOptionsPage();
});
