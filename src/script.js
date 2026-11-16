// Scripted judge: no AI. Builds each judge turn from canned lines plus what we
// scraped from the page and the user's settings. Same output shape as the live
// judge in background.js, so content.js doesn't care which one answered.
//
// Writers: all the copy lives in LINES below. Edit freely.

(() => {
  const LINES = {
    necessity: (i) => `${i.short}? That's a necessity, not a crime. Case dismissed. Go on.`,
    openLate: (i) => `It's ${i.time}. Nothing good has ever been bought after midnight. Exhibit A: ${i.short}, ${i.price}.${i.context} Convince me this can't wait until morning.`,
    openDay: (i) => `Court is in session. Exhibit A: ${i.short}, ${i.price}.${i.context} Walk me through why you need this today.`,

    rebut: {
      broken: (i) => `Replacing something that broke is a fair argument. But is ${i.short} the replacement, or the upgrade you've been eyeing?`,
      sale: () => `"It's on sale" is how stores get you. Would you buy it at full price?`,
      deserve: (i) => `Rough week, I hear you. But will ${i.short} still feel like a reward a month from now?`,
      gift: () => `Generous of you. Is this what they actually want, or what you'd want?`,
      default: (i) => `Noted for the record.${i.ruleQuote} Will you want ${i.short} just as much tomorrow morning?`,
    },

    verdictTitle: { buy: "Case made. Approved.", wait: "Sleep on it.", skip: "Not this time." },
    verdictSay: {
      buy: (i) => `Fine. You made your case. ${i.short} is approved. Enjoy it, and don't make me regret this.`,
      wait: (i) => `Not a no. Not a yes either. ${i.short} will still be there tomorrow.`,
      skip: (i) => `I'm not convinced, counselor.${i.goalLine} Put the wallet down.`,
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
    if (item.items?.length > 1) context += ` And that's just one of ${item.items.length} things in your cart.`;

    const rule = (profile.personal_rules || "").split(/\n|\.\s/).map((s) => s.trim()).filter(Boolean)[0];

    return {
      short: shortName(item.label),
      price: money(total),
      time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      late: hour >= 23 || hour < 5,
      context,
      ruleQuote: rule ? ` Your own rule says: "${rule}."` : "",
      goalLine: goal?.name && total != null ? ` Skipping this puts ${money(total)} toward ${goal.name}.` : "",
    };
  }

  function suggestion(verdict, item, profile) {
    const bf = blackFridayThisYear();
    const daysToBF = Math.ceil((bf - new Date()) / 86400000);
    if (verdict === "wait" && daysToBF > 0 && daysToBF <= 21) {
      return `Black Friday is in ${daysToBF} day${daysToBF === 1 ? "" : "s"} (${bf.toDateString()}). Check the price again then.`;
    }
    if (verdict === "wait") return "Leave it in your cart for 48 hours. If you still want it, come back.";
    if (verdict === "skip" && profile.goal?.name && item.total != null) {
      return `Move ${money(item.total)} to your ${profile.goal.name} fund instead.`;
    }
    if (verdict === "skip") return "Look for a cheaper version, or a used one.";
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
