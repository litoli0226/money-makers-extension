// Off-topic and unsafe input, checked in this browser before anything is
// scored or sent to an AI. The court only hears cases about purchases.
//
// Writers: keep these lists short and specific; false alarms interrupt a
// real trial. In AI mode the model also flags what this list misses
// (schema field "flag"). Self-harm gets the 988 Lifeline, never a joke.
(() => {
  const RULES = [
    ["self_harm", /\b(kill(ing)? myself|suicid(e|al)|end(ing)? my life|hurt(ing)? myself|self[- ]?harm|cut(ting)? myself|want to die|don'?t want to (live|be alive))\b/i],
    ["violent", /\b(kill|murder|stab|shoot|strangle|choke|torture|rape|beat up|cook|burn|poison)\s+(her|him|them|my\s+\w+|someone|people|you)\b|\b(bomb|massacre|assault)\b/i],
    ["hateful", /\b(hate|kill|exterminate|deport|ban)\s+(all\s+)?(the\s+)?(black|white|asian|jewish|jews|muslim|muslims|gay|gays|lesbians|trans|immigrant|immigrants|mexican|mexicans|women|men)\b/i],
  ];
  function check(text) {
    const t = String(text || "");
    for (const [flag, re] of RULES) if (re.test(t)) return flag;
    return null;
  }
  globalThis.gicSafety = {
    check,
    // What the court says. The self-harm line steps out of character.
    lines: {
      self_harm:
        "The court is setting the case aside. If you're thinking about hurting yourself, you can call or text 988 (Suicide & Crisis Lifeline, US), any time, free and confidential. Or chat at 988lifeline.org.",
      violent: "Stricken from the record. This court hears cases about purchases, nothing else.",
      hateful: "Stricken from the record. This court doesn't hear that kind of talk.",
      sexual: "Stricken from the record. Keep it about the purchase, defendant.",
    },
  };
})();
