// Price table for the judge's price-comparison line (MVP rule R11).
//
// Writers: these are the team's own rough numbers, not live prices (live prices
// are out of the MVP, R4). Check them before testing and edit freely. The judge
// always says "about", and only uses a row when the price is close to a whole
// number of it (or about half of it). Every trial also opens with a story about
// the judge's own (absurdly rich) past, which is allowed: the judge may invent
// stories about itself, never prices or facts about the item, the store or the
// defendant (C3).

(() => {
  const PRICE_TABLE = [
    { usd: 6, thing: "a coffee from a café", plural: "café coffees" },
    { usd: 15, thing: "a movie ticket", plural: "movie tickets" },
    { usd: 20, thing: "a large pizza", plural: "large pizzas" },
    // No tank of gas here: the court notice already said the price in gas.
    { usd: 70, thing: "a new video game", plural: "new video games" },
    { usd: 120, thing: "a dinner out for two", plural: "dinners out for two" },
    { usd: 420, thing: "a round-trip flight to Los Angeles", plural: "round-trip flights to Los Angeles" },
  ];

  // The judge's own past: the joke that opens every trial. The judge is
  // absurdly rich and mentions it in passing. {p} = the price. Writers: add
  // freely; the code picks one at random each trial, so variety doesn't depend
  // on the model's temperature.
  const ANECDOTES = [
    "I bought my first yacht with that same amount.",
    "Ah! A good {p} bought me my stock in Apple, back in the day.",
    "In my day, {p} bought a house. A small one, but on a nice street.",
    "I once tipped a valet {p}. He still sends me a card every Christmas.",
    "I keep {p} in my other robe, for emergencies.",
    "I lent a man {p} in 1987. He owns a bank now.",
    "The court spends {p} on gavel polish. Weekly.",
    "I paid {p} for this gavel. It has never lost a case.",
    "I found {p} in a coat once. The coat was mine. So was the building.",
  ];
  const pick = (list, rand = Math.random) => list[Math.floor(rand() * list.length)];
  function anecdote(priceText, rand) {
    return pick(ANECDOTES, rand).replace("{p}", priceText);
  }

  // The jab after the judge reads Exhibit A. {name} = "Mr. Moneybags".
  const JABS = {
    many: ["I guess you don't like {plural}, {name}, as that's {n} {plural}.", "You could have had {n} {plural}, {name}."],
    one: ["I guess you don't like {plural}, {name}. That's {thing}."],
    half: ["That's half of {thing}, {name}. The other half is your business."],
  };

  // Returns { kind: "table", row, n, half } or null when no row fits.
  function comparePrice(price) {
    if (price == null || !(price > 0)) return null;
    let best = null;
    for (const row of PRICE_TABLE) {
      const ratio = price / row.usd;
      const options = [];
      // Halves carry a small penalty: "3 video games" lands better than "half a flight".
      if (ratio >= 0.42 && ratio <= 0.58) options.push({ n: 0.5, err: Math.abs(ratio - 0.5) / 0.5 + 0.05 });
      const n = Math.round(ratio);
      if (n >= 1 && n <= 5) options.push({ n, err: Math.abs(ratio - n) / n });
      for (const o of options) if (o.err <= 0.15 && (!best || o.err <= best.err)) best = { row, ...o };
    }
    return best ? { kind: "table", row: best.row, n: best.n, half: best.n === 0.5 } : null;
  }

  // Scripted wording of the jab. In AI mode the model writes its own from the same match.
  function priceJab(price, name, rand) {
    const m = comparePrice(price);
    if (!m) return "";
    const t = m.half ? pick(JABS.half, rand) : m.n === 1 ? pick(JABS.one, rand) : pick(JABS.many, rand);
    return t.replaceAll("{plural}", m.row.plural).replaceAll("{thing}", m.row.thing).replaceAll("{n}", String(m.n)).replaceAll("{name}", name);
  }

  // The court notice's anchor: gas, a cost most American adults pay for, until
  // the extension knows more about the person.
  // Prices: AAA state averages for regular, Nov 18, 2026
  // (gasprices.aaa.com/state-gas-price-averages). National: $3.7502.
  // Tank: most US passenger cars hold 12 to 16 gallons (Edmunds); 14 is the middle.
  // Update STATE_GAS now and then; asOf says when.
  const GAS = { perGallon: 3.75, gallonsPerTank: 14, asOf: "Nov 18, 2026", source: "AAA" };
  const STATE_GAS = {
    AL: 3.43, AK: 4.37, AZ: 3.99, AR: 3.41, CA: 5.52, CO: 3.59, CT: 3.98, DE: 3.73, DC: 4.11, FL: 3.53,
    GA: 3.28, HI: 5.6, ID: 4.03, IL: 4.07, IN: 3.22, IA: 3.57, KS: 3.53, KY: 3.5, LA: 3.37, ME: 3.97,
    MD: 3.75, MA: 3.91, MI: 3.7, MN: 3.61, MS: 3.49, MO: 3.45, MT: 3.59, NE: 3.7, NV: 4.85, NH: 3.92,
    NJ: 3.9, NM: 3.58, NY: 4.1, NC: 3.08, ND: 3.62, OH: 3.32, OK: 3.27, OR: 4.4, PA: 4.18, RI: 3.78,
    SC: 3.33, SD: 3.65, TN: 3.38, TX: 3.22, UT: 4.0, VT: 4.06, VA: 3.66, WA: 4.77, WV: 3.83, WI: 3.55, WY: 3.86,
  };
  // First three digits of a ZIP code -> state (USPS prefix ranges; a few
  // border prefixes cross state lines, which is close enough for gas).
  const ZIP3 = [
    [5, 5, "NY"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 54, "VT"], [55, 55, "MA"], [56, 59, "VT"],
    [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"], [200, 200, "DC"], [201, 201, "VA"],
    [202, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"],
    [320, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"],
    [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"], [570, 577, "SD"],
    [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"],
    [716, 729, "AR"], [730, 732, "OK"], [733, 733, "TX"], [734, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"],
    [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"], [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"],
    [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
  ];
  function stateFromZip(zip) {
    const n = parseInt(String(zip || "").slice(0, 3), 10);
    if (!(n >= 0)) return null;
    const hit = ZIP3.find(([lo, hi]) => n >= lo && n <= hi);
    return hit ? hit[2] : null;
  }
  // Price per gallon where the order is going, or the national average.
  function gasPrice(state) {
    return state && STATE_GAS[state] ? { perGallon: STATE_GAS[state], where: state } : { perGallon: GAS.perGallon, where: "US" };
  }

  // Price -> tanks of gas, to one decimal (whole tanks past 10). Below half a
  // tank, whole gallons instead ("3 gallons of gas").
  function gasEquivalent(price, perGallon = GAS.perGallon) {
    if (price == null || !(price > 0)) return null;
    const tank = perGallon * GAS.gallonsPerTank;
    const raw = price / tank;
    if (raw < 0.5) {
      const g = Math.max(1, Math.round(price / perGallon));
      return { unit: "gallon", n: g, text: g === 1 ? "a gallon of gas" : `${g} gallons of gas`, raw, tank };
    }
    const n = raw >= 10 ? Math.round(raw) : Math.round(raw * 10) / 10;
    const num = String(n);
    const text = n === 1 ? "a tank of gas" : `${num} tanks of gas`;
    return { unit: "tank", n, num, text, raw, tank };
  }

  // What the thing is, in a word, from an Amazon title ("MALIN+GOETZ 9oz Scented
  // Candle | Hand-Poured..." -> "a candle"). Null when nothing matches.
  const NOUNS = [
    ["candle"], ["headphones", 1], ["earbuds", 1], ["earphones", 1], ["speaker"], ["keyboard"], ["mouse"], ["monitor"], ["laptop"],
    ["tablet"], ["phone case"], ["charger"], ["cable"], ["camera"], ["watch"], ["smartwatch"], ["tv"], ["console"], ["controller"],
    ["video game"], ["game"], ["book"], ["notebook"], ["planner"], ["pen", 0, "pens"], ["backpack"], ["bag"], ["wallet"], ["sneakers", 1],
    ["shoes", 1], ["boots", 1], ["sandals", 1], ["jacket"], ["hoodie"], ["sweater"], ["shirt"], ["t-shirt"], ["jeans", 1], ["pants", 1],
    ["dress"], ["hat"], ["sunglasses", 1], ["perfume"], ["cologne"], ["lipstick"], ["serum"], ["moisturizer"], ["shampoo"],
    ["blanket"], ["pillow"], ["lamp"], ["rug"], ["mug"], ["water bottle"], ["tumbler"], ["blender"], ["air fryer"], ["coffee maker"],
    ["espresso machine"], ["vacuum"], ["chair"], ["desk"], ["plant"], ["toy"], ["lego set"], ["puzzle"], ["supplement"], ["protein powder"],
  ];
  function itemNoun(title) {
    const head = String(title || "").split(/\s[|–—-]\s|,|\(/)[0].toLowerCase();
    let best = null;
    for (const [word, plural] of NOUNS) {
      const re = new RegExp(`\\b${word.replace(/[-]/g, "\\-")}(s)?\\b`);
      const m = head.match(re);
      if (m && (!best || m.index >= best.at)) best = { at: m.index, word, plural: plural || !!m[1] };
    }
    if (!best) return null;
    const w = best.plural && !best.word.endsWith("s") ? `${best.word}s` : best.word;
    return best.plural ? w : `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`;
  }

  globalThis.gicPrices = { PRICE_TABLE, ANECDOTES, JABS, anecdote, comparePrice, priceJab, GAS, STATE_GAS, stateFromZip, gasPrice, gasEquivalent, itemNoun };
})();
