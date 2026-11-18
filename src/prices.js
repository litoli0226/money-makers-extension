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
    { usd: 45, thing: "a tank of gas", plural: "tanks of gas" },
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

  globalThis.gicPrices = { PRICE_TABLE, ANECDOTES, comparePrice, priceLine };
})();
