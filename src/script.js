// Scripted judge: no AI. Builds each turn from canned lines plus what we scraped
// from the page and the user's settings. Same output shape as the live judge in
// background.js, so content.js doesn't care which one answered.
//
// Tone: playful, never guilt-trippy. Judge Penny is a TV judge who's secretly on
// your side. Writers: all the copy lives in LINES below. Edit freely.

(() => {
  const LINES = {
    necessity: (i) => `${i.short}? Counselor, that's a necessity, not a crime. Case dismissed! Off you go.`,
    openLate: (i) =>
      `Court is in session, and it's ${i.time}. Fun fact: nothing great has ever been bought after midnight. ${i.short}, ${i.price}.${i.context} Make me believe this can't wait until you've had coffee.`,
    openDay: (i) => `All rise! Well, stay seated, it's the internet. Exhibit A: ${i.short}, ${i.price}.${i.context} So, what's the story here?`,

    rebut: {
      broken: (i) => `Ooh, a strong opening. Replacing something broken is a classic. But be honest: is ${i.short} the replacement, or the glow-up?`,
      sale: () => `Ah, "it's on sale." The oldest trick in the store. Would you still want it at full price?`,
      deserve: (i) => `Rough week? The court sends a virtual hug. But will ${i.short} still feel like a treat a month from now?`,
      gift: () => `Look at you, being generous. Is it what they actually asked for, or what you'd want?`,
      default: (i) => `Noted for the record.${i.ruleQuote}${i.focusQuote} Quick gut check: will you want ${i.short} just as much tomorrow morning?`,
    },

    verdictTitle: { buy: "Approved!", wait: "Sleep on it", skip: "Overruled" },
    verdictSay: {
      buy: (i) => `The court is convinced! ${i.short} is approved. Go enjoy it, and tell your friends I'm a fair judge.`,
      wait: (i) => `Not a no, not a yes. ${i.short} isn't going anywhere, and you'll know more tomorrow.`,
      skip: (i) => `I'm not buying it, and neither should you.${i.winLine}`,
    },
  };

  const NECESSITY_WORDS = ["medicine", "tylenol", "advil", "ibuprofen", "toilet paper", "diaper", "toothpaste", "shampoo", "bandage", "vitamin", "prescription"];
  const KEYWORDS = {
    broken: ["broke", "broken", "replace", "stopped working", "died", "need it for work", "need it for school"],
    sale: ["sale", "deal", "discount", "% off", "black friday", "limited time"],
    deserve: ["deserve", "tough week", "rough week", "treat", "reward", "stressed", "sad"],
    gift: ["gift", "present", "birthday", "for my", "for her", "for him", "for them"],
  };

  const has = (text, words) => words.some((w) => text.includes(w));
  const money = (n) => (n == null ? "an unknown amount" : `$${Number(n).toFixed(2)}`);

  function shortName(label) {
    // Amazon titles are huge. Keep the first few words.
    const words = label.replace(/\s*\(.*?\)\s*/g, " ").split(/[\s,|-]+/).filter(Boolean);
    return words.slice(0, 4).join(" ");
  }

  function blackFridayThisYear() {
    const now = new Date();
    const nov1 = new Date(now.getFullYear(), 10, 1);
    const firstThu = 1 + ((4 - nov1.getDay() + 7) % 7);
    return new Date(now.getFullYear(), 10, firstThu + 21 + 1); // 4th Thursday + 1
  }

  function facts(item, profile) {
    const now = new Date();
    const hour = now.getHours();
    const goal = profile.goal;
    const budget = profile.monthly_fun_budget;
    const total = item.total;

    let context = "";
    if (total != null && budget) context += ` That's ${Math.round((total / budget) * 100)}% of your monthly fun budget.`;
    if (total != null && goal?.name && goal.target) {
      const left = Math.max(goal.target - (goal.saved_so_far || 0), 0);
      if (left > 0) context += ` Or ${Math.round((total / left) * 100)}% of what's left for ${goal.name}.`;
    }
    if (item.items?.length > 1) context += ` Plus ${item.items.length - 1} other thing${item.items.length > 2 ? "s" : ""} in the cart. I see you.`;

    const rule = (profile.personal_rules || "").split(/\n|\.\s/).map((s) => s.trim()).filter(Boolean)[0];
    const focus = (profile.cutting_back_on || "").trim();

    let winLine = "";
    if (total != null && goal?.name) winLine = ` Skip it and ${money(total)} goes toward ${goal.name}.`;
    else if (total != null) winLine = ` Skip it and ${money(total)} stays right where it is: with you.`;

    return {
      short: shortName(item.label),
      price: money(total),
      time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      late: hour >= 23 || hour < 5,
      context,
      ruleQuote: rule ? ` Your own rule says: "${rule.replace(/\.$/, "")}."` : "",
      focusQuote: !rule && focus ? ` You told me you're trying to spend less on ${focus}.` : "",
      winLine,
    };
  }

  function suggestion(verdict, item, profile) {
    const bf = blackFridayThisYear();
    const daysToBF = Math.ceil((bf - new Date()) / 86400000);
    if (verdict === "wait" && daysToBF > 0 && daysToBF <= 21) {
      return `Black Friday is in ${daysToBF} day${daysToBF === 1 ? "" : "s"} (${bf.toDateString()}). Check the price again then.`;
    }
    if (verdict === "wait") return "Leave it in your cart for 48 hours. Still want it? Come back and it's yours.";
    if (verdict === "skip" && profile.goal?.name && item.total != null) {
      return `Move ${money(item.total)} into your ${profile.goal.name} fund instead. Future you says thanks.`;
    }
    if (verdict === "skip") return "Hunting for a cheaper or secondhand version counts as a win too.";
    return "";
  }

  globalThis.gicScriptedTurn = function ({ stage, item, profile, transcript }) {
    const f = facts(item, profile);
    const said = transcript.filter((t) => t.role === "defendant").map((t) => t.text.toLowerCase()).join(" ");
    const lastDefense = (transcript.filter((t) => t.role === "defendant").pop()?.text || "").toLowerCase();

    if (stage === "open") {
      if (has(item.label.toLowerCase(), NECESSITY_WORDS)) {
        return { skip_trial: true, judge_says: LINES.necessity(f), verdict: "buy", suggestion: "" };
      }
      return { skip_trial: false, judge_says: f.late ? LINES.openLate(f) : LINES.openDay(f), verdict: "none", suggestion: "" };
    }

    if (stage === "rebut") {
      const key = Object.keys(KEYWORDS).find((k) => has(lastDefense, KEYWORDS[k])) || "default";
      return { skip_trial: false, judge_says: LINES.rebut[key](f), verdict: "none", suggestion: "" };
    }

    // verdict: a strong "broken/needed" defense wins, impulse signals lose, otherwise wait.
    let verdict = "wait";
    if (has(said, KEYWORDS.broken)) verdict = "buy";
    else if (has(said, KEYWORDS.deserve) || f.late) verdict = "skip";
    return { skip_trial: false, judge_says: LINES.verdictSay[verdict](f), verdict, suggestion: suggestion(verdict, item, profile) };
  };

  globalThis.gicVerdictTitles = LINES.verdictTitle;
})();
