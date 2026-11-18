// Settings page. Every change saves right away.
const form = document.getElementById("form");
const status = document.getElementById("status");
const DEFAULT_SKIPS = ["groceries", "textbooks", "medicine"];
let skips = DEFAULT_SKIPS;

function flash(msg) {
  status.textContent = msg;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (status.textContent = ""), 2500);
}

function showMode() {
  const mode = form.elements.mode.value;
  for (const el of document.querySelectorAll(".mode-fields")) el.hidden = el.dataset.mode !== mode;
}

function syncChips() {
  for (const chip of document.querySelectorAll("[data-skip]")) chip.classList.toggle("on", skips.includes(chip.dataset.skip));
}

async function save(msg = "Saved") {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const data = Object.fromEntries(new FormData(form));
  await chrome.storage.local.set({ settings: { ...settings, ...data, skipCategories: skips } });
  flash(msg);
}

chrome.storage.local.get({ settings: {} }).then(({ settings }) => {
  if (settings.mode === "live") settings.mode = "openrouter"; // older builds
  for (const el of form.elements) {
    if (el.name && settings[el.name] != null) el.value = settings[el.name];
  }
  skips = settings.skipCategories || DEFAULT_SKIPS;
  if (settings.mode && settings.mode !== "scripted") document.getElementById("dev").open = true;
  showMode();
  syncChips();
});

let timer;
form.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(save, 500);
});
form.elements.mode.addEventListener("change", () => {
  showMode();
  save();
});

document.getElementById("chips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-skip]");
  if (!chip) return;
  const k = chip.dataset.skip;
  skips = skips.includes(k) ? skips.filter((s) => s !== k) : [...skips, k];
  syncChips();
  save();
});

document.getElementById("updateGoal").onclick = () => save("Goal updated");
document.getElementById("removeGoal").onclick = () => {
  for (const n of ["goalName", "goalAmount", "goalDate"]) form.elements[n].value = "";
  save("Goal removed. Skips still add up.");
};

document.getElementById("reset").onclick = async () => {
  await chrome.storage.local.set({ history: [], recess: {}, wishlist: [], neverItems: [] });
  flash("History cleared");
};
