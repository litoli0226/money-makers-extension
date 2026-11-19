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
    gift: ["gift", "present", "birthday", "christmas", "anniversary", "valentine", "for my mom", "for my dad", "for my friend", "for my girlfriend", "for my boyfriend", "for my partner", "for my wife", "for my husband", "for my sister", "for my brother", "for her", "for him", "give it to", "giving it to", "give them to", "gonna give"],
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
      time: "3 min",
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
    objectionGift: (f) => `Walk the court through it: when will ${f.recipientObj === "them" ? "they" : f.recipientObj === "her" ? "she" : "he"} use it, and how?`,
    // Bridge from the how answer to the witness, so the expert has a reason to be there.
    bridge: "The court would like an expert's view on that.",
    acknowledge: {
      mechanism: () => "A plan, not just a wish.",
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
    // The expert witness gives information, never tells the judge what to ask.
    witness: {
      research: {
        topic: (f) => (f.gift ? "an expert on gift-giving" : "an expert on how people decide what to buy"),
        charge: (f) =>
          f.lastQuote ? `Witness, the defendant says "${f.lastQuote}${f.lastQuote.endsWith("…") ? "" : "."}" What does the research say?` : `Witness, what does the research say about ${f.it}?`,
      },
      usage: {
        topic: () => "an expert on cost per use",
        charge: (f) => `Witness, the defendant plans to use ${f.it} ${f.freqWords}. What does that come to?`,
        for: [(f) => `Used ${f.freqWords}, ${f.price} comes to about ${f.perUsePlan} a use over a year.`],
        against: [(f) => `Used ${f.freqWords}, it's about ${f.perUsePlan} a use. If that slips to once a week, it's ${f.perUseWeekly}.`],
      },
      price: {
        charge: (f) => `Witness, is ${f.price} a deal, or does it only feel like one?`,
        for: [() => "In my line of work, this price is ordinary. No trick here."],
        against: [() => "It feels like a deal because the page says so."],
      },
      future: {
        charge: (f) => `Future ${f.defendant}, you've lived with this choice. Was it worth it?`,
        for: [() => "Honestly? I use it more than I thought I would."],
        against: [(f) => `Honestly? I don't remember wanting it this much. I do remember the ${f.price}.`],
      },
      item: {
        charge: (f) => `${f.The}, what happens to you after the box is opened?`,
        for: [() => "I get used. Daily."],
        against: [() => "First week, I'm the favorite. By week three, I'm in a drawer."],
      },
      wallet: {
        charge: (f) => `Wallet, you've seen ${f.price} leave before. How did it go?`,
        for: [() => "Fine, actually. When it's planned, I don't mind."],
        against: [() => "It left quietly. I never heard from it again."],
      },
    },
    // The arc after the witness (each step names its research):
    //  1. advocacy: the defendant advises a friend in the same spot. First half
    //     of hypocrisy induction (Aronson, Fried & Stone 1991; Stone et al. 1994:
    //     advocate a standard, then be made mindful of your own lapses).
    //  2. values: the judge holds them to their own advice (Cialdini's
    //     consistency) and asks what else the money could do, inside a value
    //     they hold (opportunity cost cues: Frederick et al. 2009).
    //  3. closing: the court says it's about to deliberate and asks a calibrated
    //     "what" question (Voss), so the defendant can sway the ruling once more.
    advocacy: {
      gift: (f) => `Defendant, say a friend is about to spend ${f.price} on ${f.noun} for ${f.theirRecipient}. What do you tell them?`,
      usage: (f) => `Defendant, say a friend swears they'll use ${f.noun} ${f.freqWords}. What do you tell them?`,
      other: (f) => `Defendant, say a friend is about to spend ${f.price} on ${f.noun}. What do you tell them?`,
    },
    values: {
      gift: (f) => `${f.adviceLine}You want to be good to ${f.recipientObj}. What else could ${f.price} do for ${f.recipientObj}?`,
      other: (f) => `${f.adviceLine}What else could ${f.price} do for you, or for someone you care about, this month?`,
    },
    // One last turn before deliberation: a calibrated "what" question.
    closing: [
      () => "The court is about to deliberate. What should it weigh most before it decides?",
      (f) => `The court is about to deliberate. What would have to be true for ${f.it} to be worth ${f.price}?`,
    ],
    respondQ: {
      research: (f) => (f.gift ? "Defendant, is this gift for them, or for you?" : "Ah, but that must be different for you, right, defendant?"),
      item: (f) => `Defendant, ${f.the} has spoken. Your response?`,
      wallet: () => "Defendant, your wallet has testified. Your response?",
      price: () => "Defendant, could you wait two weeks and see if the price holds?",
      usage: () => "Defendant, will that plan survive a busy week?",
      future: () => "Defendant, anything you'd like to say to your future self?",
    },
    giftCheck: (f) => `Mmm... ${f.defendant} buys for the other Moneybags. If this is a gift, that changes the verdict.`,
    reason: {
      approve: (f) => `${f.bestQuote ? `You said "${f.bestQuote}" and backed it up.` : "You made your case and backed it up."} Case approved.`,
      sleep: (f) =>
        f.advice ? `${f.adviceSaid} Sleep on it, and take your own advice. ${f.The} will still be here tomorrow.` : `Your case has a point, but not a finished one. Sleep on it: ${f.the} will still be here tomorrow.`,
      denied: (f) =>
        f.advice ? `${f.adviceSaid} The court is taking your advice. That's ${f.price} you keep.` : `Your case sounded more like a want than a need right now. That's ${f.price} you keep.`,
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
    // "I'll give it to my girlfriend" names who, not how: a reason until it
    // says when or how often (SPEC), so the judge presses for the mechanism.
    if (RECIPIENT.test(t.toLowerCase()) && !SPEC.test(t)) return "reason";
    return (MECH.test(t) && words >= 6) || SPEC.test(t) ? "mechanism" : "reason";
  }

  const RECIPIENT = /\b(?:for|to)\s+my\s+(girlfriend|boyfriend|partner|wife|husband|fianc[eé]e?|mom|mother|dad|father|sister|brother|friend|best friend|roommate|grandma|grandmother|grandpa|grandfather|boss|son|daughter|kid|cousin|aunt|uncle)\b/;
  const PRONOUN = { girlfriend: "her", wife: "her", mom: "her", mother: "her", sister: "her", grandma: "her", grandmother: "her", daughter: "her", aunt: "her", fiancee: "her", "fiancée": "her",
    boyfriend: "him", husband: "him", dad: "him", father: "him", brother: "him", grandpa: "him", grandfather: "him", son: "him", uncle: "him", fiance: "him", "fiancé": "him" };
  // "honestly I'd tell them to skip it" -> "You'd tell a friend to skip it."
  // Anything else is quoted as said.
  function youdTell(advice) {
    const a = advice.replace(/^(honestly|well|um+|i mean|probably|i guess)[,\s]+/i, "");
    const m = a.match(/^(?:i'?d|i would|i'd probably|i would probably)\s+(?:tell|say to|advise)\s+(?:them|him|her|my friend|the friend)\s*(?:that\s+)?(.+)$/i);
    if (m) return `You'd tell a friend ${m[1]}.`;
    return `You'd tell a friend: "${a}."`;
  }
  function mvpFacts(ctx) {
    const f = facts(ctx);
    const t = ctx.title ? `${ctx.title} Moneybags` : "Moneybags";
    const the = f.the === "the " ? "this item" : f.the;
    const answers = ctx.answers || [];
    // Who a gift is for, from their words ("for my girlfriend").
    const rx = [...answers.map((a) => a.text), ctx.answer].map((t) => String(t || "").toLowerCase().match(RECIPIENT)).find(Boolean);
    const who = rx ? rx[1] : null;
    const pron = who ? PRONOUN[who] || "them" : "them";
    const nounRaw = globalThis.gicPrices?.itemNoun(ctx.item?.label) || "this item";
    const advice = ctx.advice ? String(ctx.advice).trim().replace(/[.!?]+$/, "").slice(0, 90) : "";
    // Usage math from the defendant's own words ("every night").
    const fr = answers.map((a) => frequency(a.text)).find(Boolean);
    const total = ctx.item?.total;
    const cents = (v) => (v >= 1 ? money(v, ctx.item?.currency) : `${Math.max(1, Math.round(v * 100))} cents`);
    return {
      ...f,
      defendant: t,
      the,
      The: the.charAt(0).toUpperCase() + the.slice(1),
      it: f.it === "the " ? "this item" : f.it,
      gift: answers.some((a) => a.claim === "gift") || !!who,
      noun: nounRaw,
      theirRecipient: who ? `their ${who}` : "someone they care about",
      recipientObj: who ? pron : "them",
      adviceLine: advice ? `${youdTell(advice)} The court will hold you to that. ` : "",
      adviceSaid: advice ? youdTell(advice) : "",
      advice,
      freq: fr,
      freqWords: fr ? fr.words : "regularly",
      perUsePlan: fr && total ? cents(total / fr.perYear) : "",
      perUseWeekly: total ? cents(total / 52) : "",
      lastQuote: (() => {
        const a = [...answers].reverse().find((x) => x.text && x.claim !== "vague");
        if (!a) return "";
        const t = String(a.text).trim().replace(/[.!?]+$/, "");
        if (t.length <= 60) return t;
        return `${t.slice(0, 60).replace(/[\s,;]+\S*$/, "")}…`; // cut at a word, not mid-word
      })(),
    };
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

  // "every night" -> 365 uses a year. Null when the answer names no frequency.
  const NUM = { once: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  function frequency(text) {
    const t = String(text || "").toLowerCase();
    const d = t.match(/\b(?:every|each) (day|night|morning|evening)\b/);
    if (d) return { perYear: 365, words: `every ${d[1]}` };
    if (/\bdaily\b|\bnightly\b/.test(t)) return { perYear: 365, words: "every day" };
    const m = t.match(/\b(\d+|once|one|twice|two|three|four|five|six|seven)\s*(?:times?\s*)?(?:a|per|each)\s*(day|week|month)\b/);
    if (m) {
      const n = NUM[m[1]] || parseInt(m[1], 10);
      const per = { day: 365, week: 52, month: 12 }[m[2]];
      return { perYear: n * per, words: `${m[1] === "1" ? "once" : m[1]}${/^(once|twice)$/.test(m[1]) ? "" : " times"} a ${m[2]}` };
    }
    if (/\b(every|each) week(end)?s?\b|\bweekly\b|\bweekends\b/.test(t)) return { perYear: 52, words: "once a week" };
    if (/\bmonthly\b|\bevery month\b/.test(t)) return { perYear: 12, words: "once a month" };
    return null;
  }
  globalThis.gicFrequency = frequency;

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
          const again = f.gift || e.claim === "gift" ? MVP_LINES.objectionGift(f) : MVP_LINES.objectionAgain;
          return { kind, ...e, acknowledge: "", objection: `${first} ${again}` };
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
          const fd = globalThis.gicFindings.findingFor(f.gift ? "gift" : [...claims].reverse().find((c) => c !== "vague") || "vague");
          return { says: fd.line, cite: fd.cite, url: fd.url };
        }
        const W = MVP_LINES.witness[ctx.witness.id];
        if (ctx.format === "mvp" && W && W[ctx.witness.stance]) {
          const lines = W[ctx.witness.stance];
          return { says: lines[Math.floor(Math.random() * lines.length)](f) };
        }
        return { says: LINES.witness[ctx.witness.id](f) };
      }
      case "mvp_closing_q": {
        const c = MVP_LINES.closing;
        return { question: c[Math.floor(Math.random() * c.length)](f) };
      }
      case "mvp_bridge":
        return { line: MVP_LINES.bridge };
      case "mvp_topic":
        return { topic: (MVP_LINES.witness[ctx.witness.id].topic || (() => "an expert witness"))(f) };
      case "mvp_advocacy_q":
        return { question: (f.gift ? MVP_LINES.advocacy.gift : f.freq ? MVP_LINES.advocacy.usage : MVP_LINES.advocacy.other)(f) };
      case "mvp_values_q":
        return { question: (f.gift ? MVP_LINES.values.gift : MVP_LINES.values.other)(f) };
      case "mvp_respond_q":
        return { question: (MVP_LINES.respondQ[ctx.witness.id] || MVP_LINES.respondQ.future)(f) };
      case "mvp_respond": {
        const e = evaluate(ctx.answer);
        const t = String(ctx.answer || "").toLowerCase();
        // Advocacy: advice to wait argues against their own purchase (the court
        // will hold them to it); advice to go ahead, with a condition, supports it.
        if (ctx.step === "advocacy" && e.engaged) {
          if (/\b(wait|don'?t|do not|skip|sleep on|think (about|twice)|hold off|save|no(t)? (worth|now)|return|cheaper)\b/.test(t)) return { ...e, strength: "weak", acknowledge: "" };
          if (/\b(go for it|buy it|get it|do it|worth it|treat yourself|why not)\b/.test(t)) return { ...e, strength: "good", acknowledge: "" };
        }
        // Values: naming something else the money could do is a point against.
        if (ctx.step === "values" && e.engaged) {
          if (/\b(nothing|not much|this is (it|the best)|she (wants|asked)|he (wants|asked)|they (want|asked)|asked for)\b/.test(t)) return { ...e, strength: "good", acknowledge: "" };
          if (/\b(could|would|dinner|date|trip|save|saving|groceries|rent|experience|flowers|time|ticket|concert)\b/.test(t)) return { ...e, strength: "weak", acknowledge: "" };
        }
        return { ...e, acknowledge: "" };
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
