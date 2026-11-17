document.getElementById("settings").onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

document.getElementById("clear").onclick = async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ history: [], recess: {} });
  location.reload();
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
    li.title = "Show transcript";
    li.onclick = () => showTranscript(h);
    list.appendChild(li);
  }
});

const NAMES = { judge: "Judge Penny", prosecutor: "Prosecutor Pinch", defendant: "You" };

function showTranscript(h) {
  const tx = document.getElementById("tx");
  const lines = h.transcript || [];
  const plain = [`${h.title} (${h.total != null ? "$" + h.total : "no price"}) -> ${h.verdict} / ${h.outcome}`, ...lines.map((l) => `${NAMES[l.role] || l.role}: ${l.text}`)].join("\n");
  tx.innerHTML = "";
  if (!lines.length) tx.append(Object.assign(document.createElement("p"), { textContent: "No transcript saved for this one." }));
  for (const l of lines) {
    const p = document.createElement("p");
    const b = document.createElement("b");
    b.textContent = `${NAMES[l.role] || l.role}: `;
    p.append(b, l.text);
    tx.append(p);
  }
  const copy = Object.assign(document.createElement("button"), { textContent: "Copy" });
  copy.onclick = async () => {
    await navigator.clipboard.writeText(plain);
    copy.textContent = "Copied!";
  };
  tx.append(copy);
  tx.classList.add("open");
}
