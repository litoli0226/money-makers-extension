// Scripted hearing: no AI. Two characters, Judge Penny and Prosecutor Pinch,
// built from canned lines plus what we scraped and the user's settings.
// Returns the same shape as the live hearing in background.js:
//   { lines: [{ speaker: "prosecutor" | "judge", text }], skip_trial, verdict, suggestion }
//
// Tone: playful, never guilt-trippy. Writers: all copy lives in LINES. Edit freely.

(() => {
  const LINES = {
    // ---- opening ----
    dismissProsecutor: (f) => `Your Honor, the prosecution has reviewed the evidence. It's ${f.short}. We… have no case.`,
    dismissJudge: () => `Case dismissed! Taking care of yourself isn't a crime. Carry on, and take care.`,
    charges: (f) =>
      `Your Honor, the defendant stands accused of putting ${f.short} (${f.price}) in their cart${f.late ? ` at ${f.time}` : ""}.${f.context} The prosecution smells an impulse buy.`,
    chargesCheap: (f) => `Your Honor, ${f.short}, ${f.price}. Small, sure. But small buys add up, and I intend to prove it.`,
    judgeOpen: (f) =>
      f.late
        ? `It's ${f.time}, counselor. Nothing great gets bought after midnight. Defendant, tell the court why this can't wait.`
        : `Order in the cart! Defendant, you've heard the charges. Why do you need ${f.short}?`,

    // ---- cross-examination (one line from the prosecutor, quoting the defense) ----
    cross: {
      need: (f) =>
        f.cheap
          ? `"${f.quote}" Fair enough. Last question: is this the best price, or would the pharmacy down the street do it cheaper?`
          : `"${f.quote}" A real need, I'll grant that. But does it have to be ${f.short}? Is there a cheaper version that does the same job?`,
      sale: () => `Objection! "It's on sale" isn't a reason, it's a marketing strategy. Would you still buy it at full price?`,
      deserve: (f) => `The defendant admits it's a reward. Rewards are lovely!${f.pctLine} Is there a cheaper treat that would hit the same spot?`,
      learn: (f) => `"${f.quote}" Admirable! But do you need ${f.short} to start, or could you try a cheaper or rented one first and upgrade once you're hooked?`,
      gift: () => `Generous! But did they actually ask for this, or is it what you'd want?`,
      want: (f) => `"${f.quote}" Wanting isn't a crime. It's not a defense either. Will you still be using ${f.short} a month from now?`,
      vague: (f) => `Objection, vague! "${f.quote}" doesn't tell us why ${f.short} has to happen today.${f.ruleQuote}${f.focusQuote}`,
    },

    // ---- closing + verdict ----
    closing: {
      buy: () => `The prosecution rests. Honestly? They got me.`,
      wait: () => `The prosecution rests, and asks the court for a cooling-off period.`,
      skip: () => `The prosecution rests. I think the facts speak for themselves, Your Honor.`,
    },
    verdictTitle: { buy: "Approved!", wait: "Sleep on it", skip: "Overruled" },
    verdict: {
      buy: (f) => `The court finds the defense convincing.${f.strongQuote ? ` "${f.strongQuote}" carried the day.` : ""} ${f.short} is approved!`,
      wait: (f) => `Both sides made fair points. The court orders a short cooling-off period for ${f.short}.`,
      skip: (f) => `The court isn't convinced ${f.short} is worth ${f.price} right now.${f.winLine}`,
    },
  };

  // Health and household basics. Cheap ones get dismissed at the door.
  const ESSENTIAL_WORDS = [
    "melatonin", "sleep aid", "vitamin", "supplement", "allergy", "antihistamine", "cold & flu", "cough", "pain relief",
    "ibuprofen", "acetaminophen", "tylenol", "advil", "aspirin", "bandage", "first aid", "sunscreen", "toothpaste",
    "toothbrush", "floss", "deodorant", "shampoo", "conditioner", "soap", "tampon", "pads", "diaper", "toilet paper",
    "paper towel", "contact lens", "prescription", "medicine", "thermometer", "laundry detergent", "dish soap",
  ];
  const ESSENTIAL_DISMISS_UNDER = 40;
  const CHEAP_UNDER = 20;

  const KEYWORDS = {
    need: [
      "need", "sleep", "insomnia", "doctor", "prescribed", "health", "pain", "sick", "medicine", "ran out", "run out",
      "running out", "refill", "every day", "everyday", "every night", "daily", "broke", "broken", "replace",
      "stopped working", "for work", "for school", "for class",
    ],
    sale: ["sale", "deal", "discount", "% off", "black friday", "limited time", "coupon"],
    deserve: ["deserve", "tough week", "rough week", "treat", "reward", "stressed", "sad", "bad day"],
    learn: ["learn", "practice", "hobby", "skill", "career", "lessons", "get into"],
    gift: ["gift", "present", "birthday", "christmas", "for my mom", "for my dad", "for my friend", "for her", "for him"],
    want: ["want", "cute", "cool", "looks", "aesthetic", "tiktok", "saw it", "influencer", "pretty", "nice"],
  };

  const has = (text, words) => words.some((w) => text.includes(w));
  const money = (n, cur) => (n == null ? "an unknown amount" : `$${Number(n).toFixed(2)}${cur && cur !== "USD" ? ` ${cur}` : ""}`);
  const categoryOf = (text) => Object.keys(KEYWORDS).find((k) => has(text.toLowerCase(), KEYWORDS[k])) || "vague";

  function quote(text, max = 70) {
    const t = text.trim().replace(/\s+/g, " ");
    return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}…` : t;
  }

  function shortName(label) {
    // Amazon titles are huge. Keep the brand-ish first few words, minus sizes.
    const words = label
      .replace(/\s*\(.*?\)\s*/g, " ")
      .split(/[\s,|]+/)
      .filter((w) => w && !/^\d+(\.\d+)?(mg|ml|oz|g|kg|ct|pack|count)?$/i.test(w));
    return words.slice(0, 4).join(" ");
  }

  function blackFriday() {
    const now = new Date();
    const nov1 = new Date(now.getFullYear(), 10, 1);
    const firstThu = 1 + ((4 - nov1.getDay() + 7) % 7);
    return new Date(now.getFullYear(), 10, firstThu + 22);
  }

  function facts(item, profile, defenses) {
    const now = new Date();
    const hour = now.getHours();
    const goal = profile.goal;
    const budget = profile.monthly_fun_budget;
    const total = item.total;
    const short = shortName(item.label);

    let context = "";
    if (total != null && budget) context += ` That's ${Math.round((total / budget) * 100)}% of their monthly fun budget.`;
    if (total != null && goal?.name && goal.target) {
      const left = Math.max(goal.target - (goal.saved_so_far || 0), 0);
      if (left > 0) context += ` Or ${Math.round((total / left) * 100)}% of what's left for their ${goal.name}.`;
    }
    if (item.items?.length > 1) context += ` Plus ${item.items.length - 1} more item${item.items.length > 2 ? "s" : ""} in the cart.`;

    const rule = (profile.personal_rules || "").split(/\n|\.\s/).map((s) => s.trim()).filter(Boolean)[0];
    const focus = (profile.cutting_back_on || "").trim();
    const needDefense = defenses.find((d) => categoryOf(d) === "need");

    let winLine = "";
    if (total != null && goal?.name) winLine = ` Skipping it puts ${money(total, item.currency)} toward your ${goal.name}.`;
    else if (total != null) winLine = ` That's ${money(total, item.currency)} staying in your pocket.`;

    return {
      short,
      shortLower: short.toLowerCase(),
      price: money(total, item.currency),
      time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      late: hour >= 23 || hour < 5,
      cheap: total != null && total < CHEAP_UNDER,
      context,
      pctLine: total != null && budget ? ` But this one is ${Math.round((total / budget) * 100)}% of your fun budget.` : "",
      ruleQuote: rule ? ` Your own rule says: "${rule.replace(/\.$/, "")}."` : "",
      focusQuote: !rule && focus ? ` And you told us you're cutting back on ${focus}.` : "",
      quote: quote(defenses[defenses.length - 1] || ""),
      strongQuote: needDefense ? quote(needDefense, 50) : "",
      winLine,
    };
  }

  function decide(item, defenses, f) {
    const cats = defenses.map(categoryOf);
    if (cats.includes("need")) return "buy";
    if (cats.includes("learn")) return "wait";
    if (f.cheap && !cats.includes("deserve") && !f.late) return "buy";
    if (cats.includes("deserve") || cats.includes("want") || f.late) return item.total != null && item.total >= 25 ? "skip" : "wait";
    return "wait";
  }

  function suggestion(verdict, item, profile, f, defenses) {
    if (verdict === "buy") return f.cheap ? "" : "Check the reviews once more, then enjoy it guilt-free.";
    const days = Math.ceil((blackFriday() - new Date()) / 86400000);
    if (verdict === "wait" && item.total >= 40 && days > 0 && days <= 21) {
      return `Black Friday is in ${days} day${days === 1 ? "" : "s"}. If you still want it then, it might be cheaper too.`;
    }
    if (verdict === "wait" && defenses.some((d) => categoryOf(d) === "learn")) return "Try a cheaper, used or rented version for a month. Still hooked? Upgrade with a clear conscience.";
    if (verdict === "wait") return "Leave it in your cart for 48 hours. Still want it? Come back and it's yours.";
    if (profile.goal?.name && item.total != null) return `Move ${money(item.total, item.currency)} into your ${profile.goal.name} fund instead.`;
    return "A cheaper or secondhand version counts as a win too.";
  }

  globalThis.gicScriptedTurn = function ({ stage, item, profile, transcript }) {
    const defenses = transcript.filter((t) => t.role === "defendant").map((t) => t.text);
    const f = facts(item, profile, defenses);
    const say = (speaker, text) => ({ speaker, text });

    if (stage === "open") {
      const essential = has(item.label.toLowerCase(), ESSENTIAL_WORDS);
      if (essential && (item.total == null || item.total < ESSENTIAL_DISMISS_UNDER)) {
        return {
          lines: [say("prosecutor", LINES.dismissProsecutor(f)), say("judge", LINES.dismissJudge(f))],
          skip_trial: true,
          verdict: "buy",
          suggestion: "",
        };
      }
      return {
        lines: [say("prosecutor", f.cheap ? LINES.chargesCheap(f) : LINES.charges(f)), say("judge", LINES.judgeOpen(f))],
        skip_trial: false,
        verdict: "none",
        suggestion: "",
      };
    }

    if (stage === "rebut") {
      const cat = categoryOf(defenses[defenses.length - 1] || "");
      return { lines: [say("prosecutor", LINES.cross[cat](f))], skip_trial: false, verdict: "none", suggestion: "" };
    }

    const verdict = decide(item, defenses, f);
    return {
      lines: [say("prosecutor", LINES.closing[verdict](f)), say("judge", LINES.verdict[verdict](f))],
      skip_trial: false,
      verdict,
      suggestion: suggestion(verdict, item, profile, f, defenses),
    };
  };

  globalThis.gicVerdictTitles = LINES.verdictTitle;
})();
