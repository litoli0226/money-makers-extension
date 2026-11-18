// Fake chrome APIs for the preview page, so the UI runs without the real
// extension storage. Always uses the scripted court.
const store = {
  settings: { goalName: "Spring break", goalAmount: "600", goalDate: "2027-03-07", savedSoFar: "270", mode: "scripted" },
  history: [], recess: {}, neverItems: [], wishlist: [],
};
if (new URLSearchParams(location.search).has("nogoal")) store.settings = { savedSoFar: "84", mode: "scripted" };
window.chrome = {
  storage: { local: { get: async (d) => ({ ...(typeof d === "object" ? d : {}), ...store }), set: async (o) => Object.assign(store, o) } },
  runtime: { sendMessage: async () => ({ ok: false, error: "preview" }) },
};
document.addEventListener("submit", (e) => e.preventDefault());
