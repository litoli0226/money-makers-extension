document.getElementById("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

const OUTCOME_LABELS = {
  kept: "kept",
  bought: "bought",
  "pleaded guilty": "pleaded",
  recessed: "recess",
  "skipped court": "skipped",
  "left court": "left",
  necessity: "necessity",
};

chrome.storage.local.get({ history: [], settings: {} }).then(({ history, settings }) => {
  const kept = history.filter((h) => h.outcome === "kept").reduce((t, h) => t + (h.total || 0), 0);
  const hearings = history.filter((h) => h.verdict !== "none").length;
  document.getElementById("kept").textContent = `$${kept.toFixed(0)}`;
  const toward = settings.purpose !== "conscious" && settings.goalName ? ` toward ${settings.goalName}` : " in your pocket";
  document.getElementById("summary").textContent = `kept${toward} · ${hearings} hearing${hearings === 1 ? "" : "s"}`;

  if (!history.length) return;
  const list = document.getElementById("history");
  list.innerHTML = "";
  for (const h of history.slice(0, 6)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = h.title;
    const tag = document.createElement("span");
    tag.className = `tag ${h.outcome === "kept" ? "kept" : ""}`;
    tag.textContent = OUTCOME_LABELS[h.outcome] || h.outcome;
    li.append(name, tag);
    list.appendChild(li);
  }
});
