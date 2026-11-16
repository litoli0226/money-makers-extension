document.getElementById("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

chrome.storage.local.get({ history: [], settings: {} }).then(({ history, settings }) => {
  const kept = history.filter((h) => h.outcome === "kept").reduce((t, h) => t + (h.total || 0), 0);
  const trials = history.filter((h) => h.verdict !== "none").length;
  document.getElementById("kept").textContent = `$${kept.toFixed(0)}`;
  const goal = settings.goalName ? ` toward ${settings.goalName}` : "";
  document.getElementById("summary").textContent = `kept${goal} · ${trials} trial${trials === 1 ? "" : "s"}`;

  const list = document.getElementById("history");
  for (const h of history.slice(0, 6)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = h.title;
    const outcome = document.createElement("span");
    outcome.textContent = h.outcome;
    li.append(name, outcome);
    list.appendChild(li);
  }
});
