// Hearing rules. These decide the shape of every trial: how many rounds, when
// the expert witness is called, when the court ends early, extends, or calls a
// recess. They live in code (not in the AI prompt) so the key moments happen
// for the same reason every time, in scripted and live mode alike.
//
// Every answer the shopper gives is scored on one scale:
//   strong +2 · good +1 · neutral 0 · weak -1 · impulse -2
// plus an "engaged" flag (false for "idk", one-word or off-topic answers).
// The score is the sum. The AI (or the scripted keyword matcher) only scores
// answers and writes lines. It never decides what happens next.

(() => {
  const RULES = {
    rounds: 4, // a normal trial is 4 questions
    maxRounds: 6, // extra rounds stop here
    minRounds: 2, // never rule before 2 answers
    disengagedLimit: 2, // 2 low-effort answers end the trial early
    decidedAt: 4, // a score of +4 or -4 after minRounds means the court has heard enough
    witnessAfter: 2, // the witness can only be called after answer 2...
    witnessWithin: 1, // ...and only if the score is between -1 and +1 (too close to call)
    approveAt: 2, // final score +2 or more: case approved
    saveAt: -1, // final score -1 or less: save it
    // A final score of 0 or +1 means a reasonable case that didn't clear the bar.
    // +1 earns an extra round first ("needs more convincing"). If it's still
    // short when rounds run out, the court calls a recess.
  };

  const STRENGTH = { strong: 2, good: 1, neutral: 0, weak: -1, impulse: -2 };

  // The one-line reasons the court gives at each key moment. Same words every time.
  const MOMENTS = {
    witness: "This one's too close to call. The court calls an expert witness.",
    extend: "The court is leaning your way but needs a little more convincing. One more round.",
    decided: "The court has heard enough.",
    disengaged: "Short answers noted. The court will rule on what it has.",
    rounds: "That's all the questions. The court will now deliberate.",
  };

  const score = (state) => state.answers.reduce((t, a) => t + (STRENGTH[a.strength] ?? 0), 0);

  // What happens after the latest answer.
  // Returns { action: "ask" | "witness" | "extend" | "rule", moment? }
  function next(state) {
    const n = state.answers.length;
    const s = score(state);
    const lowEffort = state.answers.filter((a) => !a.engaged).length;

    if (lowEffort >= RULES.disengagedLimit) return { action: "rule", moment: MOMENTS.disengaged };
    if (n >= RULES.minRounds && Math.abs(s) >= RULES.decidedAt) return { action: "rule", moment: MOMENTS.decided };
    if (!state.witnessCalled && n === RULES.witnessAfter && Math.abs(s) <= RULES.witnessWithin) {
      return { action: "witness", moment: MOMENTS.witness };
    }
    if (n >= state.totalRounds) {
      const leaningYes = s > 0 && s < RULES.approveAt;
      if (leaningYes && state.totalRounds < RULES.maxRounds) return { action: "extend", moment: MOMENTS.extend };
      return { action: "rule", moment: MOMENTS.rounds };
    }
    return { action: "ask" };
  }

  // "approve" | "save" | "recess"
  function verdict(state) {
    const s = score(state);
    if (s >= RULES.approveAt) return "approve";
    if (s <= RULES.saveAt) return "save";
    return "recess";
  }

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

  globalThis.gicFlow = { RULES, STRENGTH, MOMENTS, WITNESSES, score, next, verdict, pickWitness };
})();
