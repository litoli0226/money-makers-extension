// Price table for the judge's price-comparison line (MVP rule R11).
//
// Writers: these are the team's own rough numbers, not live prices (live prices
// are out of the MVP, R4). Check them before testing and edit freely. The judge
// always says "about", and only uses a row when the price is close to a whole
// number of it (or about half of it). When nothing fits, the judge tells a story
// about its own past instead (the Apple-stock line), which is allowed: the judge
// may invent stories about itself, never prices or facts about the item, the
// store or the defendant (C3, pending team).

(() => {
  const PRICE_TABLE = [
    { usd: 6, thing: "a coffee from a café", plural: "café coffees" },
    { usd: 15, thing: "a movie ticket", plural: "movie tickets" },
    { usd: 20, thing: "a large pizza", plural: "large pizzas" },
    { usd: 52, thing: "a tank of gas", plural: "tanks of gas" },
    { usd: 70, thing: "a new video game", plural: "new video games" },
    { usd: 120, thing: "a dinner out for two", plural: "dinners out for two" },
    { usd: 420, thing: "a round-trip flight to Los Angeles", plural: "round-trip flights to Los Angeles" },
  ];

  // The judge's own past, for prices with no good row. {p} = the price.
  const ANECDOTES = [
    "Ah! A good {p} bought me my stock in Apple, back in the day.",
    "{p}. The court once paid that for a gavel. Worth every cent.",
    "{p}. In my day, that was a month of law school lunches.",
  ];

  // Returns { kind: "table", row, n, half } or { kind: "anecdote", line }.
  function comparePrice(price, seed = 0) {
    if (price == null || !(price > 0)) return null;
    let best = null;
    for (const row of PRICE_TABLE) {
      const ratio = price / row.usd;
      const options = [];
      if (ratio >= 0.42 && ratio <= 0.58) options.push({ n: 0.5, err: Math.abs(ratio - 0.5) / 0.5 });
      const n = Math.round(ratio);
      if (n >= 1 && n <= 5) options.push({ n, err: Math.abs(ratio - n) / n });
      for (const o of options) if (o.err <= 0.15 && (!best || o.err <= best.err)) best = { row, ...o };
    }
    if (best) return { kind: "table", row: best.row, n: best.n, half: best.n === 0.5 };
    return { kind: "anecdote", template: ANECDOTES[Math.abs(seed) % ANECDOTES.length] };
  }

  // Scripted wording. In AI mode the model writes its own wording from the same match.
  function priceLine(price, priceText, seed = 0) {
    const m = comparePrice(price, seed);
    if (!m) return "";
    if (m.kind === "anecdote") return m.template.replace("{p}", priceText);
    if (m.half) return `${priceText}. They say that's about half of ${m.row.thing} today.`;
    if (m.n === 1) return `${priceText}. They say that's about ${m.row.thing} today.`;
    return `${priceText}. They say that's about ${m.n} ${m.row.plural} today.`;
  }

  // The court notice's anchor: gas, a cost most American adults pay for, until
  // the extension knows more about the person. Update perGallon now and then.
  // AAA national average for regular, Nov 18, 2026: $3.7502 (gasprices.aaa.com).
  // Tank: most US passenger cars hold 12 to 16 gallons (Edmunds); 14 is the middle.
  const GAS = { perGallon: 3.75, gallonsPerTank: 14, asOf: "Nov 18, 2026", source: "AAA national average" };
  const FRACTION = { 0: "", 0.25: "¼", 0.5: "½", 0.75: "¾" };

  // Price -> tanks of gas, to the nearest quarter tank. Below half a tank,
  // whole gallons instead ("3 gallons of gas"), since "¼ tank" reads as nothing.
  function gasEquivalent(price) {
    if (price == null || !(price > 0)) return null;
    const tank = GAS.perGallon * GAS.gallonsPerTank;
    const raw = price / tank;
    if (raw < 0.5) {
      const g = Math.max(1, Math.round(price / GAS.perGallon));
      return { unit: "gallon", n: g, text: g === 1 ? "a gallon of gas" : `${g} gallons of gas`, raw, tank };
    }
    const q = raw >= 10 ? Math.round(raw) : Math.round(raw * 4) / 4; // past 10, whole tanks
    const whole = Math.floor(q);
    const frac = FRACTION[q - whole] || "";
    const num = whole === 0 ? frac : `${whole}${frac}`;
    const text = q === 1 ? "a tank of gas" : whole === 0 ? `${frac} of a tank of gas` : `${num} tanks of gas`;
    return { unit: "tank", n: q, num, text, raw, tank };
  }

  globalThis.gicPrices = { PRICE_TABLE, ANECDOTES, comparePrice, priceLine, GAS, gasEquivalent };
})();
