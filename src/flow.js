// Hearing rules. These decide the shape of every trial, following the team's
// Figma user flow (Step 4: 4 rounds by default, 3 if low motivation, 4+ if the
// answers show confusion or debate). They live in code, not in the AI prompt,
// so the key moments happen for the same reason every time, in scripted and
// live mode alike.
//
// Every answer is scored on one scale:
//   strong +2 · good +1 · neutral 0 · weak -1 · impulse -2
// plus two flags:
//   engaged  false for "idk", one-word or off-topic answers (low motivation)
//   unsure   true for "maybe", "still thinking", "I guess", "trying" (debate)
// The AI (or the scripted keyword matcher) only scores answers and writes
// lines. It never decides what happens next.

(() => {
  const RULES = {
    rounds: 4, // default experience: 4 questions
    shortRounds: 3, // low motivation or a clear-cut case: verdict after 3
    maxRounds: 6, // extra rounds stop here
    disengagedLimit: 2, // 2 low-effort answers by round 3 = low motivation
    decidedAt: 4, // a score of +4 or -4 by round 3 = the case is clear
    witnessAfter: 2, // the witness can only be called after answer 2...
    witnessWithin: 1, // ...and only if the score is between -1 and +1 (too close to call)
    approveAt: 2, // final score +2 or more: "Go for it" (case approved). Otherwise "Save it".
  };

  const STRENGTH = { strong: 2, good: 1, neutral: 0, weak: -1, impulse: -2 };

  // The one-line reasons the court gives at each key moment. Same words every time.
  const MOMENTS = {
    witness: "This one's too close to call. The court calls an expert witness.",
    recess: "The court calls a short recess. Your case isn't settled yet, so it gets another round.",
    decided: "The court has heard enough.",
    disengaged: "Short answers noted. The court will rule on what it has.",
    rounds: "That's all the questions. The court will now deliberate.",
  };

  const score = (state) => state.answers.reduce((t, a) => t + (STRENGTH[a.strength] ?? 0), 0);

  // What happens after the latest answer.
  // Returns { action: "ask" | "witness" | "recess" | "rule", moment? }
  function next(state) {
    const n = state.answers.length;
    const s = score(state);
    const lowEffort = state.answers.filter((a) => !a.engaged).length;

    if (n >= RULES.shortRounds && lowEffort >= RULES.disengagedLimit) return { action: "rule", moment: MOMENTS.disengaged };
    if (n >= RULES.shortRounds && Math.abs(s) >= RULES.decidedAt) return { action: "rule", moment: MOMENTS.decided };
    if (!state.witnessCalled && n === RULES.witnessAfter && Math.abs(s) <= RULES.witnessWithin) {
      return { action: "witness", moment: MOMENTS.witness };
    }
    if (n >= state.totalRounds) {
      // Not settled: the last answers were on the fence, or the case is
      // leaning yes but hasn't cleared the bar. One more round, via a recess.
      const onTheFence = state.answers.slice(-2).some((a) => a.unsure);
      const almost = s > 0 && s < RULES.approveAt;
      if ((onTheFence || almost) && state.totalRounds < RULES.maxRounds) return { action: "recess", moment: MOMENTS.recess };
      return { action: "rule", moment: MOMENTS.rounds };
    }
    return { action: "ask" };
  }

  // "approve" ("Go for it") | "save" ("Save it")
  const verdict = (state) => (score(state) >= RULES.approveAt ? "approve" : "save");

  // Which expert takes the stand depends on what the shopper has been arguing.
  const WITNESSES = {
    price: { id: "price", name: "Price analyst", role: "Expert witness" },
    usage: { id: "usage", name: "Cost-per-use analyst", role: "Expert witness" },
    future: { id: "future", name: "Future you", role: "Expert witness · one month from now" },
  };
  function pickWitness(state) {
    const claims = state.answers.map((a) => a.claim);
    if (claims.includes("price")) return WITNESSES.price;
    if (claims.some((c) => c === "need" || c === "usage" || c === "learn")) return WITNESSES.usage;
    return WITNESSES.future;
  }

  // ---------- Guest-trial MVP (branch guest-trial-mvp) ----------
  //
  // The team's MVP rules (see "Money Makers: rules the judge runs on (MVP)").
  // A fixed spine, no recess, no extra rounds:
  //   1 name (fixed copy, title picker)        R6, C1 option (a)
  //   2 item + price line + "how" question     R6, R11
  //   3 objection, only after a reason, once   R7
  //   4 witness, every trial                   R6
  //   5 defendant responds to the witness      R6 (skipped after an objection if C1 (b) is on)
  //   6 deliberate                             R6
  //   7 verdict + sign-up                      R6, R15
  // Switches for the open conflicts live in Settings -> Court settings -> MVP test switches.

  const MVP = {
    objections: 1, // R7: the judge asks again once, then moves on whatever the answer
    approveAt: 2, // R15/C2 (rule): total +2 or more -> approve
    deniedAt: -2, // total -2 or less -> denied; anything between -> sleep on it
    giftBonus: 2, // "If this is a gift, that changes the verdict": a confirmed gift adds 2 points
  };

  // Which step comes after the latest "how" answer.
  // state.objected: the judge already objected once
  // kind: "mechanism" | "reason" | "unclear" for the latest answer
  function mvpAfterHow(state, kind) {
    if (kind !== "mechanism" && (state.objected || 0) < MVP.objections) return "object";
    return "witness";
  }

  // C1 option (b): skip "respond to the witness" when the judge objected.
  const mvpAskRespond = (state, settings) => !(settings.c1SkipRespond === "on" && state.objected);

  // "approve" | "sleep" | "denied"
  function mvpVerdict(state) {
    const s = score(state) + (state.gift === true ? MVP.giftBonus : 0);
    if (s >= MVP.approveAt) return "approve";
    if (s <= MVP.deniedAt) return "denied";
    return "sleep";
  }

  // Same three expert roles as the classic court, plus a researcher who may only
  // quote the team's findings list (R13). Gift and want/treat arguments get the researcher.
  // MVP: one expert witness, who speaks from one of three angles. The angle is
  // drawn at random from the ones that fit the case, never the same as last
  // trial's, with a random stance (for or against) so it can't be predicted.
  const EXPERT = "Expert witness";
  const MVP_WITNESSES = {
    ...WITNESSES,
    research: { id: "research", name: EXPERT, role: "quotes published studies" },
    usage: { id: "usage", name: EXPERT, role: "runs the numbers" },
    price: { id: "price", name: EXPERT, role: "checks the price" },
    item: { id: "item", name: "The item itself", role: "Witness · will live in your house" },
    wallet: { id: "wallet", name: "Your wallet", role: "Witness · has seen money leave before" },
  };
  function mvpPickWitness(state, lastId = null, rand = Math.random) {
    const claims = state.answers.map((a) => a.claim);
    const has = (...cs) => claims.some((c) => cs.includes(c));
    const pool = [["research", 2], ["price", 1]];
    if (has("need", "usage", "learn") || state.answers.some((a) => a.kind === "mechanism")) pool.push(["usage", 2]);
    const options = pool.filter(([id]) => id !== lastId);
    const total = options.reduce((t, [, w]) => t + w, 0);
    let r = rand() * total;
    const id = (options.find(([, w]) => (r -= w) < 0) || options[0])[0];
    return { ...MVP_WITNESSES[id], stance: rand() < 0.5 ? "for" : "against" };
  }

  globalThis.gicFlow = {
    RULES, STRENGTH, MOMENTS, WITNESSES, score, next, verdict, pickWitness,
    MVP, MVP_WITNESSES, mvpAfterHow, mvpAskRespond, mvpVerdict, mvpPickWitness,
  };
})();
