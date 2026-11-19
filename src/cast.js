// The court's cast: who sits on the bench and who takes the witness stand.
//
// Instead of drawing a person on the fly, each trial picks one preset per role
// from the lists below. A preset is a fixed, hand-checked combination of skin
// tone, hair style, hair color and glasses, so every combination that can show
// up has been looked at. The judge always wears the robe and white collar; the
// witness always wears the gold jacket (design-system gold).
//
// Writers / designers: add, remove or edit presets freely. Keep every value
// from the SKIN and HAIR_COLOR lists so the palette stays consistent.

(() => {
  // Six skin tones, light to deep.
  const SKIN = {
    s1: "#F6DCC6",
    s2: "#EAD7C3",
    s3: "#D9A982",
    s4: "#B97F5A",
    s5: "#9C6A48",
    s6: "#6E4630",
  };

  const HAIR_COLOR = {
    black: "#1F1A17",
    darkBrown: "#3B2A20",
    brown: "#6B4A2F",
    auburn: "#8A4B2A",
    blonde: "#C9A66B",
    grey: "#A7ACB4",
    wig: "#C6CCD3", // judicial wig, design-system Cool paper
  };

  // Hair shapes on the 64x64 figure (face: circle at 32,25, radius 12). {c} = hair color.
  const HAIR = {
    none: () => "",
    wig: (c) => `<path d="M19 24c-1-10 5-15 13-15s14 5 13 15c-2-5-7-8-13-8s-11 3-13 8z" fill="${c}"/><circle cx="19.5" cy="27" r="3" fill="${c}"/><circle cx="44.5" cy="27" r="3" fill="${c}"/>`,
    short: (c) => `<path d="M20 22c0-8 5-12 12-12s12 4 12 12c-2-2-6-3-12-3s-10 1-12 3z" fill="${c}"/>`,
    sidePart: (c) => `<path d="M21 20c1-7 6-10 11-10s10 3 11 10c-3-3-7-4-11-4s-8 1-11 4z" fill="${c}"/>`,
    curly: (c) => `<g fill="${c}"><circle cx="24" cy="15" r="6"/><circle cx="32" cy="12" r="7"/><circle cx="40" cy="15" r="6"/><circle cx="20.5" cy="21" r="4"/><circle cx="43.5" cy="21" r="4"/></g>`,
    bun: (c) => `<path d="M20 22c0-8 5-12 12-12s12 4 12 12c-2-2-6-3-12-3s-10 1-12 3z" fill="${c}"/><circle cx="32" cy="9" r="4.5" fill="${c}"/>`,
    long: (c) => `<path d="M19 27c-1-11 5-17 13-17s14 6 13 17v9c-2 0-3-2-3-5v-8c-3-3-6-4-10-4s-7 1-10 4v8c0 3-1 5-3 5z" fill="${c}"/>`,
  };

  const GLASSES = '<circle cx="27.5" cy="25" r="3.2" fill="none" stroke="#2B2F36" stroke-width="1.2"/><circle cx="36.5" cy="25" r="3.2" fill="none" stroke="#2B2F36" stroke-width="1.2"/><path d="M30.7 25h2.6" stroke="#2B2F36" stroke-width="1.2"/>';
  // The judge's eyebrows; the right one rises on an objection (CSS .eyebrow).
  const BROWS = (ink) => `<path class="brow l" d="M25 21.6h5" style="stroke:${ink}"/><path class="brow r" d="M34 21.6h5" style="stroke:${ink}"/>`;
  // Eyes, mouth and brows: ink on lighter skin, a deeper brown-black on deeper skin so they still read.
  const inkFor = (skin) => (skin === SKIN.s5 || skin === SKIN.s6 ? "#140D0A" : "#2B2F36");

  // Presets: [id, skin, hair, hairColor, glasses]
  const JUDGES = [
    ["wig-s2", "s2", "wig", "wig", false],
    ["wig-s5", "s5", "wig", "wig", false],
    ["short-grey-s4", "s4", "short", "grey", true],
    ["bun-black-s3", "s3", "bun", "black", false],
    ["curly-black-s6", "s6", "curly", "black", false],
    ["long-darkbrown-s1", "s1", "long", "darkBrown", false],
    ["none-s5-glasses", "s5", "none", "black", true],
    ["sidepart-grey-s2", "s2", "sidePart", "grey", true],
  ];
  const WITNESSES = [
    ["sidepart-brown-s2", "s2", "sidePart", "brown", true],
    ["curly-black-s5", "s5", "curly", "black", false],
    ["long-blonde-s1", "s1", "long", "blonde", false],
    ["bun-darkbrown-s3", "s3", "bun", "darkBrown", true],
    ["short-black-s6", "s6", "short", "black", false],
    ["sidepart-auburn-s2", "s2", "sidePart", "auburn", false],
    ["long-black-s4", "s4", "long", "black", true],
    ["short-grey-s3", "s3", "short", "grey", true],
  ];

  // Flat figure in the design-system palette.
  const person = (body, extra = "", top = "", skin = SKIN.s2) => {
    const ink = inkFor(skin);
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 64c0-14 9.5-22 22-22s22 8 22 22z" fill="${body}"/>${extra}<circle cx="32" cy="25" r="12" fill="${skin}"/><circle cx="27.5" cy="25" r="1.6" fill="${ink}"/><circle cx="36.5" cy="25" r="1.6" fill="${ink}"/><path d="M28.5 30q3.5 2.6 7 0" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/>${top}</svg>`;
  };

  const head = ([, skin, hair, color, glasses]) => ({ skin: SKIN[skin], top: HAIR[hair](HAIR_COLOR[color]) + (glasses ? GLASSES : "") });

  function judge(preset) {
    const h = head(preset);
    return person("#2B2F36", '<path d="M26 42l6 9 6-9z" fill="#FFFFFF"/>', h.top + BROWS(inkFor(h.skin)), h.skin);
  }
  function witness(preset) {
    const h = head(preset);
    return person("#C19F7C", '<path d="M28 42l4 6 4-6z" fill="#F3ECE4"/>', h.top, h.skin);
  }

  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // One cast per trial.
  function castCourt() {
    const j = pick(JUDGES);
    const w = pick(WITNESSES);
    return { judge: judge(j), witness: witness(w), ids: { judge: j[0], witness: w[0] } };
  }

  // The defendant ("you") stays the same blue hoodie every time.
  const defendant = () => person("#224786", "", HAIR.short("#62666F"));
  // Until the defendant makes a character: a blank grey placeholder with no
  // face, like a default profile picture. Unsatisfying on purpose.
  const blank = () =>
    `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 64c0-14 9.5-22 22-22s22 8 22 22z" fill="#C6CCD3"/><circle cx="32" cy="25" r="12" fill="#DADADC"/></svg>`;

  globalThis.gicCast = { SKIN, HAIR_COLOR, HAIR, JUDGES, WITNESSES, person, judge, witness, defendant, blank, castCourt };
})();
