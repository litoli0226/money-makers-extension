const form = document.getElementById("form");
const status = document.getElementById("status");
const cutBack = form.elements.cutBack;

function showPurpose() {
  const purpose = form.elements.purpose.value;
  for (const el of document.querySelectorAll(".purpose-fields")) el.hidden = el.dataset.purpose !== purpose;
}

function syncChips() {
  const picked = cutBack.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const chip of document.querySelectorAll(".chip")) chip.classList.toggle("on", picked.includes(chip.textContent));
}

for (const radio of form.elements.purpose) radio.addEventListener("change", showPurpose);
cutBack.addEventListener("input", syncChips);
document.getElementById("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  let picked = cutBack.value.split(",").map((s) => s.trim()).filter(Boolean);
  picked = picked.includes(chip.textContent) ? picked.filter((p) => p !== chip.textContent) : [...picked, chip.textContent];
  cutBack.value = picked.join(", ");
  syncChips();
});

chrome.storage.local.get({ settings: {} }).then(({ settings }) => {
  for (const el of form.elements) {
    if (!el.name || settings[el.name] == null) continue;
    if (el.type === "radio") el.checked = el.value === settings[el.name];
    else el.value = Array.isArray(settings[el.name]) ? settings[el.name].join(", ") : settings[el.name];
  }
  showPurpose();
  syncChips();
});

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.set({ history: [], recess: {} });
  document.getElementById("resetStatus").textContent = "History cleared.";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.neverSites = data.neverSites.split(",").map((s) => s.trim()).filter(Boolean);
  data.onboarded = true;
  await chrome.storage.local.set({ settings: data });
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 3000);
});
