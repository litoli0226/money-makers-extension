// Toolbar popup ("13 Home window" in Figma): goal, savings, recent cases.
const $ = (id) => document.getElementById(id);
const money = (n) => (n == null ? "" : Number.isInteger(+n) ? `$${+n}` : `$${(+n).toFixed(2)}`);
const ICONS = {
  scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-3 6a3 3 0 0 0 6 0L5 7zM19 7l-3 6a3 3 0 0 0 6 0l-3-6z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  dot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/></svg>',
};
const NAMES = { judge: "The judge", witness: "Expert witness", defendant: "You" };

$("settings").onclick = () => chrome.runtime.openOptionsPage();

chrome.storage.local.get({ history: [], settings: {} }).then(({ history, settings }) => {
  const isSave = (h) => h.outcome === "saved" || h.outcome === "kept";
  const saved = (Number(settings.savedSoFar) || 0) + history.filter(isSave).reduce((t, h) => t + (h.total || 0), 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  $("month").textContent = money(history.filter((h) => isSave(h) && h.date >= monthStart).reduce((t, h) => t + (h.total || 0), 0));
  $("cases").textContent = history.filter((h) => h.where === "courtroom").length;

  const target = Number(settings.goalAmount) || 0;
  if (settings.goalName && target) {
    const pct = Math.min(100, Math.round((saved / target) * 100));
    const by = settings.goalDate ? ` · by ${new Date(`${settings.goalDate}T00:00`).toLocaleDateString([], { month: "short", day: "numeric" })}` : "";
    $("goal").innerHTML = `<span class="tiny">Your goal</span><b></b><div class="bar"><i style="width:${pct}%"></i></div>
      <div class="foot"><span class="blue">${money(saved)} saved</span><span class="muted">${money(Math.max(target - saved, 0))} to go${by}</span></div>`;
    $("goal").querySelector("b").textContent = settings.goalName;
  } else {
    $("goal").innerHTML = `<span class="tiny">You've saved</span><b>${money(saved)}</b><span class="tiny">No goal yet. Add one in Settings, or just keep saving.</span>`;
  }

  if (!history.length) return;
  const list = $("history");
  list.innerHTML = "";
  for (const h of history.slice(0, 8)) {
    const [icon, cls, tag, tagCls] =
      isSave(h) ? [ICONS.scale, "", `Saved ${money(h.total)}`, "blue"]
      : h.outcome === "approved" ? [ICONS.check, "green", "Case approved", "green"]
      : h.outcome === "recessed" ? [ICONS.dot, "plain", "Recess", ""]
      : h.outcome === "never" ? [ICONS.dot, "plain", "Won't ask again", ""]
      : h.outcome === "not now" ? [ICONS.dot, "plain", "Not now", ""]
      : h.outcome === "left" ? [ICONS.dot, "plain", "Left trial", ""]
      : [ICONS.dot, "plain", "Bought", ""];
    const li = document.createElement("li");
    const when = new Date(h.date).toDateString() === new Date().toDateString() ? "Today" : new Date(h.date).toLocaleDateString([], { month: "short", day: "numeric" });
    const where = h.where === "courtroom" ? "Courtroom" : isSave(h) ? "Skipped at checkout" : "Checkout";
    li.innerHTML = `<span class="ic ${cls}">${icon}</span><span class="t"><b></b><span class="tiny">${when} · ${where}</span></span><span class="tag ${tagCls}">${tag}</span>`;
    li.querySelector("b").textContent = h.title;
    li.title = "Show transcript";
    li.onclick = () => showTranscript(h);
    list.appendChild(li);
  }
});

function showTranscript(h) {
  const tx = $("tx");
  const lines = h.transcript || [];
  tx.innerHTML = "";
  if (!lines.length) tx.append(Object.assign(document.createElement("p"), { textContent: "No courtroom transcript for this one." }));
  for (const l of lines) {
    const p = document.createElement("p");
    if (l.role === "court") {
      p.className = "court";
      p.textContent = l.text;
    } else {
      const b = document.createElement("b");
      b.textContent = `${NAMES[l.role] || l.role}: `;
      p.append(b, l.text);
    }
    tx.append(p);
  }
  if (lines.length) {
    const plain = [`${h.title} (${money(h.total) || "no price"}) -> ${h.verdict || ""} / ${h.outcome}`, ...lines.map((l) => (l.role === "court" ? `[${l.text}]` : `${NAMES[l.role] || l.role}: ${l.text}`))].join("\n");
    const copy = Object.assign(document.createElement("button"), { className: "btn ghost", textContent: "Copy transcript" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(plain);
      copy.textContent = "Copied";
    };
    tx.append(copy);
  }
  tx.classList.add("open");
}
