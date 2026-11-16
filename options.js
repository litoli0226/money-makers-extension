const form = document.getElementById("form");
const status = document.getElementById("status");

chrome.storage.local.get({ settings: {} }).then(({ settings }) => {
  for (const el of form.elements) {
    if (!el.name || settings[el.name] == null) continue;
    el.value = Array.isArray(settings[el.name]) ? settings[el.name].join(", ") : settings[el.name];
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.neverSites = data.neverSites.split(",").map((s) => s.trim()).filter(Boolean);
  data.onboarded = true;
  await chrome.storage.local.set({ settings: data });
  status.textContent = "Saved. Court is ready.";
  setTimeout(() => (status.textContent = ""), 2500);
});
