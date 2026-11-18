// Scripted court: no AI, free. Same five stages as the live court in
// background.js, built from canned lines plus what we scraped from the page.
//
//   open          -> { opening, question }
//   answer        -> { acknowledge, strength, engaged, unsure, claim, question }
//   witness       -> { says }
//   after_witness -> { question }
//   verdict       -> { reason }
//
// The rules for rounds, the witness and recess are in src/flow.js.
// Writers: all copy is in LINES and QUESTIONS below. Edit freely.

(() => {
  const LINES = {
    opening: (f) =>
      f.late
        ? `Order in the court. It's ${f.time}, which the court notes is a bold hour to shop. Let's hear your case for ${f.the}.`
        : `Order in the court. Let's hear your case for ${f.the}.`,

    // The judge's reaction to each answer, by what kind of argument it was.
    acknowledge: {
      need: (f) =>
        /broke|broken|stopped working/.test(f.lastLower)
          ? "A broken one is a fair reason. Noted."
          : /ran out|run out|running out/.test(f.lastLower)
            ? "Running out is a fair reason. Noted."
            : ["A genuine need. The court takes note.", "The court finds that persuasive.", "Another point for the defense. Noted."][f.repeat % 3],
      usage: (f) => ["Regular use counts for a lot in this court.", "Frequent use, entered into the record.", "The court likes a well-used purchase."][f.repeat % 3],
      price: () => "A discount is a fair point. The court has also seen many \"deals\" come back next week.",
      learn: () => "Self-improvement. The court admires your ambition, if not yet your cart.",
      gift: () => "Generosity is admissible. The court will allow it, for now.",
      treat: () => "The court has had weeks like that too. Noted, sympathetically.",
      want: () => "Honest. The court appreciates honesty and will hold it against you only slightly.",
      vague: (f) =>
        ["The court will need a little more than that.", "Noted, though the court is still waiting for the reason.", "The court admires the mystery. It would admire a reason more."][f.repeat % 3],
      lowEffort: (f) =>
        ["Brevity is the soul of wit, counselor, but not of a defense.", "Short and sweet. The court was hoping for less sweet, more reason.", "The court notes your economy of words."][f.repeat % 3],
    },

    witness: {
      price: () =>
        "Price analyst, under oath. Sales like this one tend to come back around. Waiting a couple of weeks rarely costs more than a few dollars, and sometimes saves more.",
      usage: (f) =>
        f.total != null
          ? `Cost-per-use analyst, under oath. At ${f.price}, using it three times a week for a year works out to about ${f.perUse} a use. Use it less and that number climbs fast.`
          : "Cost-per-use analyst, under oath. The real price of anything is what it costs each time you use it. Use it often and it's a bargain. Use it twice and it's a souvenir.",
      future: (f) =>
        `Hi, it's you, one month from now. If you skip this, I'm ${f.price} ${f.goal ? `closer to ${f.goal}` : "richer"}. Honestly? I don't remember wanting it this much.`,
    },
    afterWitness: {
      price: () => "Thank you, witness. Defendant, could you wait two weeks and see if the price holds?",
      usage: () => "Thank you, witness. Defendant, how often will you really use it? Be honest, the witness is watching.",
      future: () => "Thank you, witness. Defendant, anything you'd like to say to your future self?",
    },

    reason: {
      save: (f) =>
        `${f.mostlyWant ? "Your case sounded more like a want than a need right now." : "Your case had a point, but not enough to outweigh the cost right now."}${
          f.goal && f.pctOfLeft != null ? ` ${f.price} covers ${f.pctOfLeft}% of what's left for ${f.goal}.` : ` That's ${f.price} straight into your savings.`
        }`,
      approve: (f) =>
        `${f.bestQuote ? `You said "${f.bestQuote}" and backed it up.` : "You made your case and backed it up."} That's a solid case.${f.goal ? ` ${f.goal} stays on track.` : ""}`,
    },
  };

  // One question per round. Round 2 depends on what you argued in round 1.
  const QUESTIONS = {
    1: (f) => `What made you want ${f.the} today?`,
    2: (f) =>
      ({
        need: `How have you been managing without ${f.it}? Convince me it can't wait.`,
        usage: `Will you use ${f.it} in the next 30 days? Convince me.`,
        price: "Would you still buy it at full price?",
        learn: "Could you borrow or rent one first, in case it doesn't stick?",
        gift: "Did they ask for this one, or is it what you'd pick?",
        treat: "Is there a cheaper treat that would hit the same spot?",
      })[f.lastClaim] || `Will you use ${f.it} in the next 30 days? Convince me.`,
    3: () => "Could you get by with something cheaper, or wait two weeks?",
    4: (f) => (f.goal ? `Last question. Would you rather have ${f.it}, or ${f.price} more toward ${f.goal}?` : `Last question. Would you rather have ${f.it}, or ${f.price} more in your savings?`),
    5: () => "Give the court one concrete reason it has to be this one, and it has to be now.",
    6: () => "Final chance. What would you give up to make room for it?",
  };
  const FALLBACK_QUESTION = "What else should the court know?";

  // ---------- scoring ----------

  const KEYWORDS = {
    need: ["need", "broke", "broken", "stopped working", "ran out", "run out", "running out", "replace", "doctor", "prescribed", "health", "for work", "for school", "for class", "finals", "exam", "deadline", "essay", "assignment", "interview", "required", "lost my", "lost it"],
    usage: ["every day", "everyday", "daily", "every night", "commute", "gym", "use it", "all the time", "every week", "weekly", "times a"],
    price: ["sale", "deal", "discount", "% off", "black friday", "coupon", "cheap", "price", "cheaper", "limited time"],
    learn: ["learn", "practice", "hobby", "skill", "career", "lessons", "get into"],
    gift: ["gift", "present", "birthday", "christmas", "for my mom", "for my dad", "for my friend", "for her", "for him"],
    treat: ["deserve", "tough week", "rough week", "treat", "reward", "stressed", "sad", "bad day"],
    want: ["want", "cute", "cool", "looks", "aesthetic", "tiktok", "saw it", "influencer", "pretty", "nice", "why not"],
  };
  // Points before and after a bonus for specifics (numbers, details, more than one reason).
  const POINTS = {
    need: [1, 2], usage: [1, 2], learn: [1, 2], gift: [0, 1], price: [0, 0],
    treat: [-2, -1], want: [-2, -1], vague: [-1, 0],
  };
  const LABEL = { 2: "strong", 1: "good", 0: "neutral", "-1": "weak", "-2": "impulse" };
  const LOW_EFFORT = /^(idk|i don'?t know|dunno|because|bc|cuz|just because|no|yes|yeah|yep|nah|whatever|why not|ok|okay|i want it|want|sure)\W*$/i;

  // On the fence: earns the extra rounds in the Figma flow ("maybe, still thinking, trying").
  const UNSURE = /\b(maybe|not sure|unsure|i guess|still thinking|thinking about it|trying|kind of|sort of|probably|idk if|torn|on the fence|i think so|might)\b/i;

  const claimsIn = (lower) => Object.keys(KEYWORDS).filter((k) => KEYWORDS[k].some((w) => lower.includes(w)));

  function evaluate(text) {
    const t = text.trim();
    const words = t.split(/\s+/).filter(Boolean).length;
    const unsure = UNSURE.test(t);
    if (words < 3 || LOW_EFFORT.test(t)) return { strength: "weak", engaged: false, unsure, claim: "vague" };
    const claims = claimsIn(t.toLowerCase());
    const claim = claims[0] || "vague";
    const specific = /\d/.test(t) || words >= 14 || claims.length >= 2;
    return { strength: LABEL[POINTS[claim][specific ? 1 : 0]], engaged: true, unsure, claim };
  }

  // ---------- facts from the page and settings ----------

  // Amazon titles are huge. "Mini Projector for iPhone 1080P..." -> "Mini Projector".
  function shortName(label) {
    const cut = label.split(/,| - | \| | for | with | compatible /i)[0];
    const words = cut
      .replace(/\s*\(.*?\)\s*/g, " ")
      .split(/\s+/)
      .filter((w) => w && !/^\d+(\.\d+)?(mg|ml|oz|g|kg|ct|pack|count|p|w|in|ft)?$/i.test(w));
    return words.slice(0, 4).join(" ") || label.slice(0, 30);
  }

  function money(n, cur) {
    if (n == null) return "this";
    const v = Number(n);
    const s = Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
    return cur && cur !== "USD" ? `${s} ${cur}` : s;
  }

  function quote(text, max = 70) {
    const t = text.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
    return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}…` : t;
  }

  function facts({ item, profile, answers = [] }) {
    const now = new Date();
    const hour = now.getHours();
    const short = shortName(item.label);
    const multi = item.items?.length > 1;
    const goal = profile.goal;
    const left = goal?.target ? Math.max(goal.target - (profile.saved || 0), 0) : null;
    const last = answers[answers.length - 1];
    const ranked = [...answers].filter((a) => a.engaged).sort((a, b) => POINTS_OF(b) - POINTS_OF(a));
    const wantish = answers.filter((a) => ["want", "treat", "vague"].includes(a.claim)).length;
    return {
      short,
      the: multi ? "this cart" : `the ${short}`,
      it: multi ? "all of it" : `the ${short}`,
      price: money(item.total, item.currency),
      total: item.total,
      perUse: item.total != null ? money(Math.round((item.total / 156) * 100) / 100, item.currency) : "",
      time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      late: hour >= 23 || hour < 5,
      goal: goal?.name || "",
      pctOfLeft: left && item.total != null ? Math.round((item.total / left) * 100) : null,
      lastLower: (last?.text || "").toLowerCase(),
      lastClaim: last?.claim || "vague",
      bestQuote: ranked[0] && POINTS_OF(ranked[0]) > 0 ? quote(ranked[0].text) : "",
      mostlyWant: wantish * 2 >= answers.length,
    };
  }
  const POINTS_OF = (a) => ({ strong: 2, good: 1, neutral: 0, weak: -1, impulse: -2 })[a.strength] ?? 0;

  function question(round, f, asked) {
    const q = (QUESTIONS[round] || (() => FALLBACK_QUESTION))(f);
    return asked.includes(q) ? FALLBACK_QUESTION : q;
  }

  // ---------- stages ----------

  globalThis.gicScripted = function (stage, ctx) {
    const f = facts(ctx);
    const asked = (ctx.transcript || []).filter((t) => t.role === "judge").map((t) => t.text);
    switch (stage) {
      case "open":
        return { opening: LINES.opening(f), question: question(1, f, asked) };
      case "answer": {
        const e = evaluate(ctx.answer);
        const f2 = facts({ ...ctx, answers: [...ctx.answers, { ...e, text: ctx.answer }] });
        // How many times this kind of answer came up before, so reactions don't repeat.
        f2.repeat = ctx.answers.filter((a) => (e.engaged ? a.engaged && a.claim === e.claim : !a.engaged)).length;
        const ack = e.engaged ? LINES.acknowledge[e.claim](f2) : LINES.acknowledge.lowEffort(f2);
        return { acknowledge: ack, ...e, question: question(ctx.round + 1, f2, asked) };
      }
      case "witness":
        return { says: LINES.witness[ctx.witness.id](f) };
      case "after_witness":
        return { question: LINES.afterWitness[ctx.witness.id](f) };
      case "verdict":
        return { reason: LINES.reason[ctx.verdict](f) };
    }
    throw new Error(`Unknown stage ${stage}`);
  };

  globalThis.gicShortName = shortName;
  globalThis.gicMoney = money;
})();
