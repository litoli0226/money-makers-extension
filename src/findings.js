// Findings the witness may quote (MVP rule R13). Every entry is a published
// study the team checked. Writers: add more, but only with a real citation and
// a link you've opened. In AI mode the witness gets this list and may also speak
// from memory, but it should prefer these and never invent numbers.

(() => {
  const FINDINGS = [
    {
      id: "experiences",
      fits: ["want", "treat", "vague"],
      line: "Asked about past purchases, 57% of 1,279 adults said an experience made them happier than a thing. 34% said the thing.",
      cite: "Van Boven & Gilovich (2003), Journal of Personality and Social Psychology",
      url: "https://cdn.vanderbilt.edu/vu-wp0/wp-content/uploads/sites/59/2011/05/06143905/to-do-or-to-have.pdf",
    },
    {
      id: "gifts",
      fits: ["gift"],
      line: "People told to spend a small windfall on someone else were happier by that evening than people told to spend it on themselves.",
      cite: "Dunn, Aknin & Norton (2008), Science",
      url: "https://www.sciencedaily.com/releases/2008/03/080320150034.htm",
    },
    {
      id: "explaining",
      fits: ["need", "usage", "learn", "price"],
      line: "When shoppers explained how a product works, some wanted to pay less for it afterward. Others wanted to pay more.",
      cite: "Fernbach, Sloman, St. Louis & Shube (2013), Journal of Consumer Research",
      url: "https://econpapers.repec.org/RePEc:oup:jconrs:doi:10.1086/667782",
    },
  ];

  const findingFor = (claim) => FINDINGS.find((f) => f.fits.includes(claim)) || FINDINGS[0];

  globalThis.gicFindings = { FINDINGS, findingFor };
})();
