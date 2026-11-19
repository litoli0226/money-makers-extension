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
    return words.slice(0, 4).join(" ").replace(/\s+(&|and|\+|-|of|with)$/i, "") || label.slice(0, 30);
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

  // =====================================================================
  // Guest-trial MVP court (branch guest-trial-mvp). Same idea as above:
  // canned lines, filled in from the page. Writers (Oli): every MVP line is in
  // MVP_LINES below.
  //
  //   mvp_item     -> { line, price_line, question }
  //   mvp_how      -> { kind, acknowledge, objection?, strength, engaged, unsure, claim }
  //   witness      -> { says, cite?, url? }
  //   mvp_respond_q-> { question }
  //   mvp_respond  -> { acknowledge, strength, engaged, unsure, claim }
  //   gift_check   -> { question }
  //   mvp_verdict  -> { reason, signup }
  // =====================================================================

  const MVP_LINES = {
    // Court notice: the consent screen before the trial (Matthew's quick check, restyled).
    notice: {
      head: "Court notice",
      // A summons from the court. The gas figure appears once, in the charge.
      kicker: "Summons",
      charge: (g, what, price) => `What makes ${what} more important than ${g ? g.text : `keeping ${price}`}, defendant?`,
      body: () => "Get the court's opinion before you buy.",
      start: "Plead my case",
      time: "2 min",
      skip: "Skip court",
      never: "Don't ask about this item",
      // Just-in-time privacy notice (Chrome Web Store "prominent disclosure"):
      // what is collected, where it goes, then a link to the full policy.
      privacy: ({ ai, guest }) =>
        `${ai ? `Taking it to court sends your answers to ${ai} to write the judge's lines.` : "Your answers stay in this browser."} ${
          guest ? "Nothing is saved unless you set a goal at the end." : "Your cases are saved in this browser."
        }`,
      privacyLink: "Privacy policy",
    },
    name: "Forgive me, what's your name, defendant?",
    // "We are here in the matter of ..." is how real judges open a hearing.
    item: (f) => `We are here in the matter of ${f.defendant} v. ${f.the}, ${f.price}.`,
    how: (f) => `How will ${f.it} make your life better, defendant?`,
    howPlaceholder: "How, exactly: when, where, how often you'll use it",
    objection: "Not why, defendant. I asked how.",
    // A non-answer ("um", "idk") gets its own line: the judge heard it.
    nonAnswer: (said) => `"${said}" is not something the court can write down.`,
    objectionAgain: "Walk the court through it: when and where will you use it?",
    acknowledge: {
      mechanism: () => "A plan, not just a wish. Noted for the record.",
      reason: () => "The court has heard why. It will have to do.",
      unclear: () => "The court will take that as it is.",
    },
    callWitness: "The court will hear from a witness.",
    // Follow-up when there was no objection: pins down a number or a moment, so
    // the witness comes after two exchanges either way.
    followup: {
      usage: () => "How often, exactly? Give the court a number.",
      need: () => "And if you skip it, what happens next week?",
      gift: () => "Who is it for, and when will they use it?",
      learn: () => "How many hours a week will you put into it?",
      other: (f) => `When is the first time you'll use ${f.it}, and where?`,
    },
    secondAck: ["Entered into the record.", "The court writes that down.", "Noted. The court has what it needs from you, for now."],
    // The witness: the judge asks a charged question, the witness answers.
    // Each witness has lines for and against the purchase; the trial picks a
    // stance at random so the witness can't be predicted.
    witness: {
      research: {
        charge: (f) => `Witness, you've read the studies. Will ${f.it} make the defendant happier, or just busier?`,
      },
      usage: {
        charge: () => "Witness, the defendant says they'll use it. Run the numbers.",
        for: [(f) => `At ${f.price}, used three times a week for a year, that's about ${f.perUse} a use. Cheaper than a coffee.`, () => "Used as described, this pays for itself in use. The court has seen worse math."],
        against: [(f) => `${f.price} is cheap per use only if it gets used. I've seen plenty of things that didn't.`, () => "The numbers work on paper. The court should ask whether the plan survives a busy week."],
      },
      price: {
        charge: (f) => `Witness, is ${f.price} a deal, or does it only feel like one?`,
        for: [() => "In my line of work, this price is ordinary. No trick here.", () => "It's a fair price. Waiting won't make it a better one."],
        against: [() => "It feels like a deal because the page says so. I'd check again in two weeks.", () => "Every price is a deal on the day you want something."],
      },
      future: {
        charge: (f) => `Future ${f.defendant}, you've lived with this choice. Was it worth it?`,
        for: [() => "Honestly? I use it more than I thought I would. Don't tell my wallet.", () => "I'd buy it again. Slower this time, but I'd buy it."],
        against: [(f) => `Honestly? I don't remember wanting it this much. I do remember the ${f.price}.`, () => "It's fine. It's on a shelf. The shelf looks nice."],
      },
      item: {
        charge: (f) => `${f.The}, you'll be the one living in the house. What happens to you after the box is opened?`,
        for: [() => "I get used. Daily. Some of us are lucky.", () => "I'd be put to work by the end of the day. I've seen the plan."],
        against: [() => "First week, I'm the favorite. By week three, I'm in a drawer with the other favorites.", () => "I'll be used twice, photographed once and moved during spring cleaning."],
      },
      wallet: {
        charge: (f) => `Wallet, you've seen ${f.price} leave before. How did it go?`,
        for: [() => "Fine, actually. When it's planned, I don't mind.", () => "This one has a reason attached. Those leave on good terms."],
        against: [() => "It left quietly. I never heard from it again.", () => "I've been lighter. I don't recommend it."],
      },
    },
    respondQ: {
      research: () => "Ah, but that must be different for you, right, defendant?",
      item: (f) => `Defendant, ${f.the} has spoken. Your response?`,
      wallet: () => "Defendant, your wallet has testified. Your response?",
      price: () => "Defendant, could you wait two weeks and see if the price holds?",
      usage: () => "Defendant, the witness ran your numbers. Do they hold up in a busy week?",
      future: () => "Defendant, anything you'd like to say to your future self?",
    },
    respondAck: () => "So noted. The court will now deliberate.",
    giftCheck: (f) => `Mmm... ${f.defendant} buys for the other Moneybags. If this is a gift, that changes the verdict.`,
    reason: {
      approve: (f) => `${f.bestQuote ? `You said "${f.bestQuote}" and backed it up.` : "You made your case and backed it up."} Case approved.`,
      sleep: (f) => `Your case has a point, but not a finished one. Sleep on it: ${f.the} will still be here tomorrow.`,
      denied: (f) => `Your case sounded more like a want than a need right now. That's ${f.price} you keep.`,
    },
    // The invitation at the end: set a goal so the court can hold you to it.
    // It opens the team's goal sheet (Figma 16.1). Built from the trial.
    signup: {
      gift: (f) => `Gifts add up. Set a savings goal, and next time the court will weigh ${f.price} gifts against it.`,
      // The ruling above already quotes them, so this line doesn't repeat it.
      approve: (f) => `You came with a plan for ${f.the}. Set a savings goal, and next time I'll hold you to plans like that one.`,
      sleep: (f) => `Sleep on ${f.the}. Set a savings goal tonight, and next time the court will weigh ${f.price} against it.`,
      denied: (f) => `That's ${f.price} still yours. Set a savings goal, and the court will keep count.`,
    },
  };

  // Reason or mechanism? (R7) A mechanism says how the item gets used: a plan,
  // a time, a frequency, a setup. A reason says why it's wanted. Keyword-based in
  // scripted mode; the AI judge classifies it itself in live mode. Also used for
  // the optional live hint under the text box.
  const MECH = /\b(i'll|i will|i would|i'd|i plan to|i'm going to|every (day|night|morning|evening|week|weekend)|each (day|night|week)|daily|nightly|weekly|whenever|when i|before (bed|work|class|school)|after (work|class|school)|while i|times a (day|week|month)|on my (commute|way)|set (it |them )?up|plug|wear (it|them)|use (it|them) (to|for|on|at|in|every|when|while))\b/i;
  // Numbers and frequencies: the answers a follow-up asks for ("twice a day,
  // 40 minutes each way") count as how, even without "I will".
  const SPEC = /\b(\d+|once|twice|(one|two|three|four|five|six|seven) times|(a|per|each) (day|night|week|month|weekend)|minutes|hours)\b/i;
  function howKind(text) {
    const t = String(text || "").trim();
    const words = t.split(/\s+/).filter(Boolean).length;
    if (words < 4) return "unclear";
    return (MECH.test(t) && words >= 6) || SPEC.test(t) ? "mechanism" : "reason";
  }

  function mvpFacts(ctx) {
    const f = facts(ctx);
    const t = ctx.title ? `${ctx.title} Moneybags` : "Moneybags";
    const the = f.the === "the " ? "this item" : f.the;
    return { ...f, defendant: t, the, The: the.charAt(0).toUpperCase() + the.slice(1), it: f.it === "the " ? "this item" : f.it };
  }

  function scoreHow(text, kind) {
    const e = evaluate(text);
    // R7: how counts more than why. A mechanism counts one step stronger, a
    // reason one step weaker (both capped).
    if (kind === "mechanism" && e.engaged) {
      const up = { impulse: "weak", weak: "neutral", neutral: "good", good: "strong", strong: "strong" };
      e.strength = up[e.strength];
    }
    if (kind === "reason" && e.engaged) {
      const down = { strong: "good", good: "neutral", neutral: "weak", weak: "impulse", impulse: "impulse" };
      e.strength = down[e.strength];
    }
    return e;
  }

  globalThis.gicHowKind = howKind;
  globalThis.gicMvpLines = MVP_LINES;

  globalThis.gicScriptedMvp = function (stage, ctx) {
    const f = mvpFacts(ctx);
    switch (stage) {
      case "mvp_item": {
        const P = globalThis.gicPrices;
        const name = f.defendant;
        const what = (ctx.item.items || []).length > 1 ? "cart" : P.itemNoun(ctx.item.label);
        const label = !what ? `A ${f.price} purchase.` : /^an? /.test(what) ? `A ${f.price} ${what.replace(/^an? /, "")}.` : what === "cart" ? `A ${f.price} cart.` : `${f.price} ${what}.`;
        return {
          line: `${name}, you have brought before the court a ${f.price} purchase. ${ctx.joke || P.anecdote(f.price)} What are you spending it on?`,
          price_line: [label, P.priceJab(ctx.item.total, name)].filter(Boolean).join(" "),
          question: MVP_LINES.how(f),
        };
      }
      case "mvp_how": {
        const kind = howKind(ctx.answer);
        const e = scoreHow(ctx.answer, kind);
        if (ctx.objection_allowed && kind !== "mechanism") {
          const said = String(ctx.answer || "").trim().replace(/[.!?]+$/, "").slice(0, 40);
          const first = kind === "unclear" && said ? MVP_LINES.nonAnswer(said) : MVP_LINES.objection;
          return { kind, ...e, acknowledge: "", objection: `${first} ${MVP_LINES.objectionAgain}` };
        }
        const fu = MVP_LINES.followup[e.claim] || MVP_LINES.followup.other;
        const ack = ctx.second ? MVP_LINES.secondAck[(ctx.answers || []).length % MVP_LINES.secondAck.length] : MVP_LINES.acknowledge[kind](f);
        return { kind, ...e, acknowledge: ack, followup: fu(f) };
      }
      case "mvp_charge":
        return { question: MVP_LINES.witness[ctx.witness.id].charge(f) };
      case "witness":
      case "mvp_witness": {
        if (ctx.witness.id === "research") {
          const claims = (ctx.answers || []).map((a) => a.claim);
          // The latest argument decides the finding ("it's a gift" after "it smells nice" -> the gifts study).
          const fd = globalThis.gicFindings.findingFor([...claims].reverse().find((c) => c !== "vague") || "vague");
          return { says: fd.line, cite: fd.cite, url: fd.url };
        }
        const W = MVP_LINES.witness[ctx.witness.id];
        if (ctx.format === "mvp" && W && W[ctx.witness.stance]) {
          const lines = W[ctx.witness.stance];
          return { says: lines[Math.floor(Math.random() * lines.length)](f) };
        }
        return { says: LINES.witness[ctx.witness.id](f) };
      }
      case "mvp_respond_q":
        return { question: (MVP_LINES.respondQ[ctx.witness.id] || MVP_LINES.respondQ.future)(f) };
      case "mvp_respond": {
        const e = evaluate(ctx.answer);
        return { ...e, acknowledge: MVP_LINES.respondAck(f) };
      }
      case "gift_check":
        return { question: MVP_LINES.giftCheck(f) };
      case "mvp_verdict": {
        // Quote the defendant's "how" when there is one, not their "why".
        const mech = (ctx.answers || []).filter((a) => a.kind === "mechanism");
        const f2 = facts({ ...ctx, answers: mech.length ? mech : ctx.answers || [] });
        const v = ctx.verdict;
        const gift = ctx.gift === true || (ctx.gift == null && (ctx.answers || []).some((a) => a.claim === "gift"));
        return {
          reason: MVP_LINES.reason[v]({ ...f, bestQuote: f2.bestQuote }),
          signup: gift ? MVP_LINES.signup.gift(f) : MVP_LINES.signup[v]({ ...f, bestQuote: f2.bestQuote }),
        };
      }
    }
    throw new Error(`Unknown MVP stage ${stage}`);
  };
})();
