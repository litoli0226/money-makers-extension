// Content script. Spots the checkout moment, shows the quick check, and runs
// the courtroom. Screens follow the team's Figma (Low-Mid-Fi Wireframes
// Iteration 2, "Hi-fi prototype"). All UI lives in a shadow root so the store's
// CSS can't touch it, and ours can't break the store.

(() => {
  if (window.__mmLoaded) return;
  window.__mmLoaded = true;

  const flow = globalThis.gicFlow;
  const LIVE_TIMEOUT_MS = 25000;

  // Buttons that mean "I'm buying now". Amazon changes these, so keep a list.
  const BUY_SELECTORS = [
    "#buy-now-button",
    "input[name='proceedToRetailCheckout']",
    "[data-feature-id='proceed-to-checkout-action'] input",
    "input[data-feature-id='proceed-to-checkout-action']",
    "input[name='placeYourOrder1']",
    "#submitOrderButtonId input",
    "[data-gic-buy]", // test page
  ];
  // Fallback: match the button's visible label. Covers "Place your order in CAD" etc.
  const BUY_TEXT = /\b(proceed to (retail )?checkout|place (your )?order|buy now|continue to checkout)\b/i;

  // "Skip these purchases" chips on the settings page. Items whose title matches
  // never trigger a check-in.
  const SKIP_WORDS = {
    groceries: ["grocery", "snack", "coffee", "cereal", "pasta", "rice", "milk", "bread", "oatmeal", "granola"],
    textbooks: ["textbook", "isbn", "workbook", "study guide", "lab manual", "loose-leaf", "loose leaf"],
    medicine: [
      "melatonin", "sleep aid", "vitamin", "supplement", "allergy", "antihistamine", "cold & flu", "cough", "pain relief",
      "ibuprofen", "acetaminophen", "tylenol", "advil", "aspirin", "bandage", "first aid", "prescription", "medicine",
      "thermometer", "contact lens", "sunscreen",
    ],
    bills: [],
    gifts: ["gift"],
    toiletries: ["toothpaste", "toothbrush", "floss", "deodorant", "shampoo", "conditioner", "soap", "tampon", "pads", "razor", "toilet paper", "paper towel"],
    transit: ["transit", "bus pass", "presto", "metrocard"],
  };
  const DEFAULT_SKIPS = ["groceries", "textbooks", "medicine"];

  let pendingButton = null; // the buy button we intercepted
  let allowNextClick = false;

  const log = (...args) => console.log("[MM]", ...args);

  function labelOf(el) {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const labelled = ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
    // Amazon wraps <input> in <span class="a-button"> with the text in a sibling span.
    const wrapper = el.closest(".a-button")?.textContent || "";
    return [el.value, el.getAttribute("aria-label"), labelled, el.textContent, wrapper].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function findBuyButton(target) {
    const bySelector = target.closest?.(BUY_SELECTORS.join(","));
    if (bySelector) return bySelector;
    const clickable = target.closest?.("input[type=submit], input[type=button], button, a, [role=button], .a-button");
    if (!clickable) return null;
    // If they clicked Amazon's wrapper span, act on the real input inside it.
    const real = clickable.matches(".a-button") ? clickable.querySelector("input, button, a") || clickable : clickable;
    const label = labelOf(real);
    return label.length < 80 && BUY_TEXT.test(label) ? real : null;
  }

  // ---------- scraping ----------

  const text = (sel, root = document) => root.querySelector(sel)?.textContent.trim() || "";
  const firstText = (sels, root = document) => {
    for (const s of sels) {
      const t = text(s, root);
      if (t) return t;
    }
    return "";
  };
  const num = (s) => {
    const m = String(s ?? "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  };

  function pageType() {
    const p = location.pathname;
    if (/\/(gp\/buy|checkout)(\/|$)/.test(p)) return "checkout";
    if (/\/(gp\/cart|cart)(\/|$)/.test(p)) return "cart";
    if (document.querySelector("#productTitle")) return "product";
    return null;
  }

  // Checked on a live amazon.com product page (Nov 2026).
  function scrapeProduct() {
    const title = firstText(["#productTitle"]);
    const price = num(
      firstText([
        "#corePrice_feature_div .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#apex_desktop .a-price .a-offscreen",
        ".a-price .a-offscreen",
      ])
    );
    return title ? { items: [{ title, price }], total: price } : null;
  }

  // Cart rows carry data-producttitle / data-price / data-quantity (checked on live amazon.com/cart, Nov 2026).
  // Only read rows inside the active cart: "Saved for later" uses the same row markup.
  function scrapeCart() {
    const seen = new Set();
    const items = [];
    for (const row of document.querySelectorAll("#sc-active-cart .sc-list-item[data-asin], #sc-active-cart [data-asin][data-price]")) {
      const asin = row.dataset.asin;
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      const title = row.dataset.producttitle || firstText([".sc-product-title", ".a-truncate-full", "a.sc-product-link"], row);
      if (!title) continue;
      items.push({
        title,
        price: num(row.dataset.price) ?? num(firstText([".a-price .a-offscreen", ".sc-product-price"], row)),
        quantity: parseInt(row.dataset.quantity, 10) || 1,
      });
    }
    const sum = items.reduce((t, i) => t + (i.price || 0) * i.quantity, 0);
    const total = num(firstText(["#sc-subtotal-amount-activecart", "#sc-subtotal-amount-buybox"])) ?? sum;
    return items.length ? { items, total } : null;
  }

  // Find "Order total: CA$12.34" style rows by their text.
  function totalByLabel() {
    const labels = [...document.querySelectorAll("td, span, div, dt, li")].filter(
      (el) => el.children.length <= 2 && /^\s*(order total|total)\s*:?\s*$/i.test(el.textContent)
    );
    for (const el of labels) {
      const row = el.closest(".order-summary-grid, tr, li, .a-row, [class*=row], div");
      const n = num(row?.textContent.replace(el.textContent, ""));
      if (n) return n;
    }
    return null;
  }

  // Checked on live amazon.com Place Your Order page (Nov 2026). Two tables exist: a hidden
  // USD "marketplace" one and the visible "transactional" one in the shopper's currency.
  function scrapeCheckout() {
    const totalText = firstText([
      "#subtotals-transactional-table .grand-total-cell",
      "#subtotals-marketplace-table .grand-total-cell",
      ".grand-total-cell",
      ".grand-total-price",
      "[data-testid='order-summary-total']",
    ]);
    const total = num(totalText) ?? totalByLabel();
    const currency = (totalText.match(/\b(USD|CAD|EUR|GBP|AUD)\b/) || [])[1];
    const titles = [...document.querySelectorAll(".item-title, .lineitem-title-text")].map((el) => el.textContent.trim()).filter(Boolean);
    const items = titles.length ? titles.map((title) => ({ title })) : [{ title: "Your order" }];
    return { items, total, currency };
  }

  function scrapeItem() {
    const type = pageType();
    const data = type === "product" ? scrapeProduct() : type === "cart" ? scrapeCart() : type === "checkout" ? scrapeCheckout() : null;
    if (!data) return null;
    const names = data.items.map((i) => i.title);
    return {
      ...data,
      label: names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} more`,
      site: location.hostname,
      page: type,
    };
  }

  // ---------- storage ----------

  const getStore = () => chrome.storage.local.get({ settings: {}, history: [], neverItems: [], wishlist: [] });

  const savedTotal = (settings, history) =>
    (Number(settings.savedSoFar) || 0) +
    history.filter((h) => h.outcome === "saved" || h.outcome === "kept").reduce((t, h) => t + (h.total || 0), 0);

  async function logOutcome(item, outcome, extra = {}) {
    const { history } = await getStore();
    history.unshift({ date: Date.now(), title: item.label, total: item.total, outcome, ...extra });
    await chrome.storage.local.set({ history: history.slice(0, 200) });
  }

  async function addToWishlist(item) {
    const { wishlist } = await getStore();
    wishlist.unshift({ date: Date.now(), title: item.label, total: item.total, url: location.href });
    await chrome.storage.local.set({ wishlist: wishlist.slice(0, 100) });
  }

  // Local checks that skip the check-in entirely.
  function skipReason(settings, neverItems, item) {
    if (neverItems.includes(item.label)) return "you asked never to be asked about this item";
    const custom = String(settings.skipCustom || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (custom.some((s) => location.hostname.includes(s))) return "this store is on your skip list";
    const cats = settings.skipCategories || DEFAULT_SKIPS;
    const words = [...cats.flatMap((c) => SKIP_WORDS[c] || []), ...custom];
    // Whole words only, so "iPads" isn't "pads" and "Price" isn't "rice".
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchers = words.map((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}s?($|[^a-z0-9])`, "i"));
    const titles = item.items.map((i) => i.title);
    const hit = (t) => words.find((w, n) => matchers[n].test(t));
    if (titles.length && titles.every(hit)) return `everything here is on your skip list (matched "${hit(titles[0])}")`;
    return null;
  }

  function profileFrom(settings, history) {
    const target = Number(settings.goalAmount) || null;
    return {
      goal: settings.goalName ? { name: settings.goalName, target, by: settings.goalDate || null } : null,
      saved: savedTotal(settings, history),
    };
  }

  // ---------- UI shell ----------

  const host = document.createElement("div");
  host.id = "money-makers-root";
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647; inset:auto;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CSS()}</style><div id="layer"></div>`;
  const layer = shadow.getElementById("layer");
  document.documentElement.appendChild(host);
  loadFont();

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n, cur) => globalThis.gicMoney(n, cur);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => layer.querySelector(sel);
  const on = (sel, fn) => {
    const el = $(sel);
    if (el) el.onclick = fn;
  };

  function clearUI() {
    layer.innerHTML = "";
    host.style.inset = "auto";
  }
  // Quick check sits top-right over the page. Everything else takes over the page.
  function showPanel(html) {
    host.style.inset = "0 0 auto auto";
    layer.innerHTML = `<div class="panel-wrap"><div class="panel" role="dialog">${html}</div></div>`;
  }
  function showPage(html, cls = "") {
    host.style.inset = "0";
    layer.innerHTML = `<div class="page ${cls}">${html}</div>`;
  }

  // Once you've chosen to go ahead, don't check in again on the next checkout step.
  const CLEARED_KEY = "mmClearedAt";
  const CLEARED_MS = 20 * 60 * 1000;
  const isCleared = () => {
    try {
      return Date.now() - Number(sessionStorage.getItem(CLEARED_KEY) || 0) < CLEARED_MS;
    } catch {
      return false;
    }
  };

  function proceedWithPurchase() {
    try {
      sessionStorage.setItem(CLEARED_KEY, String(Date.now()));
    } catch {}
    clearUI();
    if (pendingButton) {
      allowNextClick = true;
      const btn = pendingButton;
      pendingButton = null;
      btn.click();
    }
  }

  // Urbanist comes from the service worker as bytes (see background.js).
  async function loadFont() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "font" });
      if (!res?.ok) return;
      const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
      const face = new FontFace("Urbanist", bytes.buffer, { weight: "400 700" });
      await face.load();
      document.fonts.add(face);
    } catch (e) {
      log("Font not loaded, using system font.", e?.message);
    }
  }

  // ---------- shared pieces ----------

  function goalMath(profile, item) {
    const g = profile.goal;
    const price = item?.total || 0;
    const before = profile.saved;
    const after = before + price;
    if (g?.target) {
      const pct = (v) => Math.min(100, Math.round((v / g.target) * 100));
      let milestone = "";
      if (pct(before) < 50 && pct(after) >= 50 && pct(after) < 100) milestone = `you're past halfway to ${g.name}.`;
      if (pct(before) < 100 && pct(after) >= 100) milestone = `that's your ${g.name} goal reached.`;
      return { hasGoal: true, target: g.target, before, after, pctBefore: pct(before), pctAfter: pct(after), left: Math.max(g.target - after, 0), milestone };
    }
    const step = 100;
    const next = (Math.floor(before / step) + 1) * step;
    const pct = (v) => Math.min(100, Math.round((v / next) * 100));
    return {
      hasGoal: false,
      target: next,
      before,
      after,
      pctBefore: pct(before),
      pctAfter: pct(after),
      left: Math.max(next - after, 0),
      milestone: after >= next ? `you're past $${next} saved.` : "",
    };
  }

  const bar = (pct) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;

  // The goal card used on the quick check ("before") and the saved screens ("after").
  function goalCard(profile, m, mode) {
    const g = profile.goal;
    const value = mode === "after" ? m.after : m.before;
    const pct = mode === "after" ? m.pctAfter : m.pctBefore;
    if (m.hasGoal) {
      return `<div class="card goal">
        <div class="tiny">Saved for ${esc(g.name)} so far</div>
        <div class="amount"><b>${money(value)}</b><span>of ${money(m.target)}</span></div>
        ${bar(pct)}
        <div class="bar-foot"><span>${pct}% there</span>${
          mode === "before" ? `<span class="blue">Skip it → ${m.pctAfter}%</span>` : `<span>${money(Math.max(m.target - value, 0))} to go</span>`
        }</div>
      </div>`;
    }
    return `<div class="card goal">
      <div class="row-between"><span class="tiny">You've saved so far</span>${
        mode === "before" ? `<button class="chip gold" data-act="setgoal">+ Set a goal</button>` : ""
      }</div>
      <div class="amount"><b>${money(value)}</b><span>· next milestone ${money(m.target)}</span></div>
      ${bar(pct)}
      <div class="bar-foot"><span>${pct}% of the way</span>${mode === "before" ? `<span class="blue">Skip it → ${m.pctAfter}%</span>` : ""}</div>
    </div>`;
  }

  // Slim goal line on the verdict screens.
  function goalLine(profile) {
    const g = profile.goal;
    if (!g?.target) return "";
    const pct = Math.min(100, Math.round((profile.saved / g.target) * 100));
    return `<div class="card goal-line"><div class="row-between"><span>${esc(g.name)}</span><span class="blue">${money(profile.saved)} of ${money(g.target)}</span></div>${bar(pct)}</div>`;
  }

  // ---------- 02 Quick check ----------

  function showQuickCheck(item, settings, history, note = "") {
    const profile = profileFrom(settings, history);
    const m = goalMath(profile, item);
    const short = globalThis.gicShortName(item.label);
    const the = item.items.length > 1 ? "this cart" : `the ${short}`;
    const price = money(item.total, item.currency);
    const hint = m.milestone
      ? `<div class="hint">${ICON.star}<span>This would ${m.hasGoal ? (m.pctAfter >= 100 ? "finish your goal" : "get you past halfway") : `push you past ${money(m.target)} saved`}</span></div>`
      : "";
    showPanel(`
      <div class="panel-head"><span>Quick check</span><button class="icon-btn" data-act="close" aria-label="Close">${ICON.x}</button></div>
      ${goalCard(profile, m, "before")}
      <h2 class="h2">Do you really need it?</h2>
      <p class="muted">${
        m.hasGoal ? `If you skip ${esc(the)}, ${price} goes to ${esc(profile.goal.name)} instead.` : `If you skip ${esc(the)}, that's ${price} straight into your savings.`
      }</p>
      ${note ? `<p class="note">${esc(note)}</p>` : ""}
      ${hint}
      <div class="stack">
        <button class="btn primary" data-act="save">You're right. I'll save it</button>
        <button class="btn outline" data-act="court">Yes, I want it</button>
      </div>
      <button class="link" data-act="never">Never ask about this item</button>`);
    $("[data-act=save]").focus();
    // Flow step 3, "Not now": the X lets the order go through, no guilt message.
    on("[data-act=close]", async () => {
      await logOutcome(item, "not now");
      proceedWithPurchase();
    });
    on("[data-act=setgoal]", () => chrome.runtime.sendMessage({ type: "openOptions" }));
    on("[data-act=save]", () => saveIt(item, settings, history, "checkout", "panel"));
    on("[data-act=court]", () => startTrial(item, settings, history));
    on("[data-act=never]", async () => {
      const { neverItems } = await getStore();
      await chrome.storage.local.set({ neverItems: [...new Set([item.label, ...neverItems])].slice(0, 500) });
      await logOutcome(item, "never");
      proceedWithPurchase();
    });
  }

  // ---------- 03 / 11 Saved ----------

  async function saveIt(item, settings, history, where, style, transcript = []) {
    const profile = profileFrom(settings, history); // before this save
    const m = goalMath(profile, item);
    await logOutcome(item, "saved", { where, transcript });
    await addToWishlist(item);
    pendingButton = null;
    const short = globalThis.gicShortName(item.label);
    const by = profile.goal?.by ? new Date(`${profile.goal.by}T00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    const html = `
      <div class="confetti" aria-hidden="true">${CONFETTI}</div>
      <div class="seal blue">${ICON.dollar}</div>
      <h2 class="h2 center">Nice, you just saved ${money(item.total, item.currency)}</h2>
      ${goalCard(profile, m, "after")}
      ${m.milestone ? `<div class="hint box">${ICON.star}<span>Milestone: ${esc(m.milestone)}</span></div>` : ""}
      ${
        m.hasGoal
          ? ""
          : `<button class="card row-link" data-act="goal">${ICON.flag}<span><b>Give your savings a goal</b><small>A trip, a laptop, a safety net. Every dollar you skip counts toward it.</small></span>${ICON.arrow}</button>`
      }
      <div class="card wish"><span class="thumb"></span><span>${esc(short)} is on your Guilty If Charged wishlist.${by ? ` Revisit it after ${esc(by)}.` : ""}</span></div>
      <button class="btn primary" data-act="done">Done</button>`;
    if (style === "panel") showPanel(html);
    else showPage(`<div class="card-lg">${html}</div>`, "centered");
    on("[data-act=done]", clearUI);
    on("[data-act=goal]", () => showGoalSheet(item, profile.saved + (item.total || 0), style));
  }

  // ---------- 16.1 Goal sheet ----------

  function showGoalSheet(item, saved, style) {
    const kinds = [
      ["Trip", ICON.plane],
      ["Safety net", ICON.shield],
      ["Laptop", ICON.laptop],
      ["Something else", ICON.plus],
    ];
    const html = `
      <h2 class="h2">One more thing: What are you saving for?</h2>
      <div class="chips">${kinds.map(([k, i], n) => `<button class="chip${n === 0 ? " on" : ""}" data-kind="${k}">${i}${k}</button>`).join("")}</div>
      <div class="two">
        <label>Name it<input id="gname" value="Spring break" /></label>
        <label>Amount<input id="gamount" inputmode="decimal" placeholder="600" /></label>
      </div>
      <p class="blue center small" id="gpreview"></p>
      <button class="btn primary" data-act="savegoal">Save my goal</button>
      <button class="link" data-act="later">Skip. I'll do it in Settings</button>`;
    if (style === "panel") showPanel(html);
    else showPage(`<div class="card-lg">${html}</div>`, "centered");
    const name = $("#gname");
    const amount = $("#gamount");
    for (const el of [name, amount]) el.addEventListener("keydown", (e) => e.stopPropagation());
    const preview = () => {
      const a = Number(amount.value);
      $("#gpreview").textContent = a > 0 ? `${money(saved)} of ${money(a)} already done. That's ${Math.min(100, Math.round((saved / a) * 100))}%.` : "";
    };
    amount.addEventListener("input", preview);
    for (const chip of layer.querySelectorAll("[data-kind]")) {
      chip.onclick = () => {
        layer.querySelectorAll("[data-kind]").forEach((c) => c.classList.toggle("on", c === chip));
        const k = chip.dataset.kind;
        name.value = k === "Trip" ? "Spring break" : k === "Something else" ? "" : k;
        name.focus();
      };
    }
    on("[data-act=later]", clearUI);
    on("[data-act=savegoal]", async () => {
      if (!name.value.trim() || !(Number(amount.value) > 0)) return amount.focus();
      const { settings } = await getStore();
      await chrome.storage.local.set({ settings: { ...settings, goalName: name.value.trim(), goalAmount: String(Number(amount.value)) } });
      clearUI();
    });
  }

  // ---------- 05-07 Courtroom ----------

  async function courtTurn(stage, ctx, settings, onFallback) {
    if (settings.mode === "openrouter" || settings.mode === "anthropic") {
      try {
        const res = await Promise.race([
          chrome.runtime.sendMessage({ type: "court", stage, ctx }),
          wait(LIVE_TIMEOUT_MS).then(() => ({ ok: false, error: "The AI took too long." })),
        ]);
        if (res?.ok) return res.turn;
        throw new Error(res?.error || "No response");
      } catch (e) {
        log("Live court failed, using the script for this turn:", e.message);
        onFallback?.(e.message);
      }
    } else {
      await wait(650); // a beat so it doesn't feel instant
    }
    return globalThis.gicScripted(stage, ctx);
  }

  async function startTrial(item, settings, history) {
    const profile = profileFrom(settings, history);
    const short = globalThis.gicShortName(item.label);
    const transcript = [];
    const state = { answers: [], round: 1, totalRounds: flow.RULES.rounds, witnessCalled: false, witness: null };
    let warned = false;

    showPage(`
      <div class="topbar"><span id="round"></span><button class="chip-btn" data-act="leave">Leave trial ${ICON.x}</button></div>
      <div class="court-stage">
        <div class="scene" id="scene" aria-hidden="true">
          <div class="seal-wall">${ICON.scale}</div>
          <div class="spot witness" data-who="witness">
            <div class="figure">${FIGURE.witness}<span class="speech"><i></i><i></i><i></i></span></div>
            <div class="stand"><span class="plate">Witness stand</span></div>
          </div>
          <div class="spot judge" data-who="judge">
            <div class="figure">${FIGURE.judge}<span class="speech"><i></i><i></i><i></i></span></div>
            <div class="bench"><span class="plate">The judge</span></div>
          </div>
          <div class="spot defendant" data-who="defendant">
            <div class="figure">${FIGURE.defendant}<span class="speech"><i></i><i></i><i></i></span></div>
            <div class="table"><span class="plate">You</span></div>
          </div>
        </div>
        <div class="chat" role="log" aria-label="Courtroom">
          <div class="chat-head"><span class="av judge">${ICON.scale}</span><span><b>The judge</b><small>Hearing your case for ${item.items.length > 1 ? "this cart" : `the ${esc(short)}`}</small></span></div>
          <div class="log" id="log" aria-live="polite"></div>
          <form class="composer" id="composer">
            <input id="answer" autocomplete="off" placeholder="Make your case" disabled />
            <button class="send" aria-label="Send" disabled>${ICON.send}</button>
          </form>
        </div>
        <p class="fine">No right or wrong answers. The verdict is advice. You always decide.</p>
      </div>`, "court");

    const logEl = $("#log");
    const input = $("#answer");
    const send = $(".send");
    const roundEl = $("#round");
    const setRound = () => (roundEl.textContent = `Round ${state.round} of ${state.totalRounds}`);
    setRound();

    // Flow: "Leave trial" (any round) -> back to cart, no verdict.
    on("[data-act=leave]", () => {
      state.left = true;
      logOutcome(item, "left", { where: "courtroom", transcript });
      pendingButton = null;
      clearUI();
      if (pageType() === "checkout") location.href = `${location.origin}/cart`;
    });

    const scroll = () => (logEl.scrollTop = logEl.scrollHeight);
    // Courtroom scene: whoever is talking stands up and gets the highlight.
    const scene = $("#scene");
    function setSpeaker(who, thinking = false) {
      for (const spot of scene.querySelectorAll(".spot")) {
        spot.classList.toggle("talking", spot.dataset.who === who);
        spot.classList.toggle("thinking", thinking && spot.dataset.who === who);
      }
    }
    function say(role, text, opts = {}) {
      transcript.push({ role, text });
      setSpeaker(role);
      const row = document.createElement("div");
      if (role === "defendant") {
        row.className = "msg me";
        row.innerHTML = `<div class="bubble">${esc(text)}</div>`;
      } else if (role === "witness") {
        row.className = "msg witness";
        row.innerHTML = `<span class="av gold">${ICON.witness}</span><div><div class="who">${esc(state.witness.name)} <span>· ${esc(state.witness.role)}</span></div><div class="bubble">${esc(text)}</div></div>`;
      } else {
        row.className = "msg judge";
        row.innerHTML = `<span class="av judge">${ICON.scale}</span><div class="bubble${opts.question ? " q" : ""}">${esc(text)}</div>`;
      }
      logEl.appendChild(row);
      scroll();
    }
    function moment(text) {
      transcript.push({ role: "court", text });
      const row = document.createElement("div");
      row.className = "moment";
      row.textContent = text;
      logEl.appendChild(row);
      scroll();
    }
    function typing(who = "judge") {
      setSpeaker(who, true);
      const row = document.createElement("div");
      row.className = `msg ${who} typing`;
      row.innerHTML = `<span class="av ${who === "witness" ? "gold" : "judge"}">${who === "witness" ? ICON.witness : ICON.scale}</span><div class="bubble"><i></i><i></i><i></i></div>`;
      logEl.appendChild(row);
      scroll();
      return () => row.remove();
    }
    const readPause = (t) => wait(Math.min(1400, 350 + t.length * 12));
    const fallbackNote = (err) => {
      if (warned) return;
      warned = true;
      moment(`AI court unavailable (${err}). Using the scripted court for now.`);
    };
    const ctx = (extra = {}) => ({
      item: { label: item.label, short, total: item.total, currency: item.currency, items: item.items, site: item.site },
      profile,
      transcript,
      answers: state.answers,
      round: state.round,
      rounds_planned: state.totalRounds,
      ...extra,
    });
    async function ask(stage, extra, who = "judge") {
      const stop = typing(who);
      try {
        return await courtTurn(stage, ctx(extra), settings, fallbackNote);
      } finally {
        stop();
      }
    }
    function openInput() {
      input.disabled = send.disabled = false;
      input.value = "";
      input.focus();
    }

    // Opening
    const open = await ask("open");
    say("judge", open.opening);
    await readPause(open.opening);
    say("judge", open.question, { question: true });
    openInput();

    input.addEventListener("keydown", (e) => e.stopPropagation()); // keep the store's shortcuts out of it
    input.addEventListener("input", () => input.value && setSpeaker("defendant", true));
    $("#composer").onsubmit = async (e) => {
      e.preventDefault();
      const answer = input.value.trim();
      if (!answer || input.disabled) return;
      input.disabled = send.disabled = true;
      input.value = "";
      say("defendant", answer);

      const r = await ask("answer", { answer, next_round: state.round + 1 });
      if (state.left) return;
      state.answers.push({ text: answer, strength: r.strength, engaged: r.engaged !== false, unsure: !!r.unsure, claim: r.claim });
      log("Answer scored", r.strength, r.claim, r.engaged ? "" : "(low effort)", "score", flow.score(state));
      say("judge", r.acknowledge);
      await readPause(r.acknowledge);

      const step = flow.next(state);
      if (step.action === "rule") {
        moment(step.moment);
        await wait(1200);
        if (state.left) return;
        return deliberate(item, settings, history, profile, state, transcript, ctx);
      }
      if (step.action === "witness") {
        moment(step.moment);
        state.witnessCalled = true;
        state.witness = flow.pickWitness(state);
        const stand = scene.querySelector(".spot.witness");
        stand.classList.add("called");
        stand.querySelector(".plate").textContent = state.witness.name;
        await wait(600);
        const w = await ask("witness", { witness: state.witness }, "witness");
        say("witness", w.says);
        await readPause(w.says);
        state.round += 1;
        setRound();
        const q = await ask("after_witness", { witness: state.witness });
        say("judge", q.question, { question: true });
        return openInput();
      }
      if (step.action === "recess") {
        moment(step.moment);
        state.totalRounds += 1;
      }
      state.round += 1;
      setRound();
      say("judge", r.question, { question: true });
      openInput();
    };
  }

  // ---------- 08 Deliberating ----------

  async function deliberate(item, settings, history, profile, state, transcript, ctx) {
    const verdict = flow.verdict(state);
    const n = state.answers.length;
    const steps = [
      [`Reviewing your ${n === 1 ? "answer" : `${n} answers`}`, `${n} answer${n === 1 ? "" : "s"} on the record`],
      state.witnessCalled ? ["Considering the expert testimony", state.witness.name] : null,
      ["Weighing need versus want", ""],
      [profile.goal ? `Checking it against your ${profile.goal.name} goal` : "Checking it against your savings", ""],
    ].filter(Boolean);
    showPage(`
      <div class="card-lg">
        <div class="seal soft ring">${ICON.scale}</div>
        <h2 class="h2 center">The court is deliberating…</h2>
        <p class="muted center">Hang tight, this takes a few seconds.</p>
        <ul class="checks">${steps.map(([t, s]) => `<li><span class="tick"></span><span><b>${esc(t)}</b>${s ? `<small>${esc(s)}</small>` : ""}</span></li>`).join("")}</ul>
      </div>`, "centered");
    const reasonP = courtTurn("verdict", ctx({ verdict }), settings);
    // Paced so each check reads as real work: about 1.5s per step, then a beat.
    const items = [...layer.querySelectorAll(".checks li")];
    for (const li of items) {
      li.classList.add("active");
      await wait(1500);
      li.classList.replace("active", "done");
      await wait(250);
    }
    const { reason } = await reasonP;
    await wait(700);
    transcript.push({ role: "judge", text: reason });
    showVerdict(item, settings, history, profile, verdict, reason, transcript);
  }

  // ---------- 09 / 10 Verdict: "Save it" or "Go for it" ----------

  function showVerdict(item, settings, history, profile, verdict, reason, transcript) {
    const price = money(item.total, item.currency);
    const V = {
      save: { seal: `<div class="seal blue ring">${ICON.scale}</div>`, title: "Save it for later", box: "blue", primary: `Save ${price}`, secondary: "Appeal and buy anyway" },
      approve: { seal: `<div class="seal green ring">${ICON.check}</div>`, title: "Case approved", box: "green", primary: "Continue to checkout", secondary: "Actually, save it instead" },
    }[verdict];
    showPage(`
      <div class="card-lg">
        ${V.seal}
        <p class="kicker center">The court rules…</p>
        <h2 class="h1 center">${V.title}</h2>
        <div class="reason r-${V.box}">${esc(reason)}</div>
        ${goalLine(profile)}
        <button class="btn primary" data-act="primary">${esc(V.primary)}</button>
        <button class="link" data-act="secondary">${esc(V.secondary)}</button>
      </div>`, "centered");
    $("[data-act=primary]").focus();
    const record = { where: "courtroom", verdict, transcript };

    // Approved: straight back to checkout. "Totally okay, you thought it
    // through" is only for appealing a "Save it" ruling and buying anyway.
    on("[data-act=primary]", async () => {
      if (verdict === "save") return saveIt(item, settings, history, "courtroom", "page", transcript);
      await logOutcome(item, "approved", record);
      proceedWithPurchase();
    });
    on("[data-act=secondary]", async () => {
      if (verdict === "approve") return saveIt(item, settings, history, "courtroom", "page", transcript);
      await logOutcome(item, "bought", record);
      showTotallyOkay(profile);
    });
  }

  // ---------- 12 Totally okay ----------

  function showTotallyOkay(profile) {
    showPage(`
      <div class="card-lg">
        <h2 class="h1">Totally okay. You thought it through.</h2>
        <p class="muted">Buying things you want is part of the plan too. ${profile.goal ? "Your goal is right where you left it." : "Your savings are right where you left them."}</p>
        ${goalLine(profile)}
        <button class="btn primary" data-act="back">Back to checkout</button>
        <p class="fine center">The trial closes and the store's checkout continues.</p>
      </div>`, "centered");
    on("[data-act=back]", proceedWithPurchase);
  }

  // ---------- triggers ----------

  async function maybeCheckIn() {
    if (isCleared()) {
      log("Already went through a check-in in this tab in the last 20 minutes. Letting it through.");
      return false;
    }
    const { settings, history, neverItems } = await getStore();
    const item = scrapeItem();
    if (!item) {
      log("No item found on this page.", { page: pageType(), path: location.pathname });
      return false;
    }
    const skip = skipReason(settings, neverItems, item);
    if (skip) {
      log(`Skipping: ${skip}.`);
      return false;
    }
    log("Checking in on", item);
    showQuickCheck(item, settings, history);
    return true;
  }

  // Intercept "buy" clicks (capture phase, before the store's handlers).
  document.addEventListener(
    "click",
    async (e) => {
      if (e.composedPath().includes(host)) return; // clicks inside our own UI
      const btn = findBuyButton(e.target);
      if (!btn) return;
      log("Buy button clicked:", labelOf(btn));
      if (allowNextClick) {
        allowNextClick = false;
        return;
      }
      if (isCleared()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      pendingButton = btn;
      const shown = await maybeCheckIn();
      if (!shown) proceedWithPurchase(); // nothing to check, let it through
    },
    true
  );

  // Flow step 2: the nudge appears when you click a checkout button, not before.
  log("Loaded on", pageType() || "an untracked page", location.pathname);

  // ---------- icons ----------

  const svg = (body, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
  const ICON = {
    scale: svg('<path d="M12 4v16M8 20h8M5 7h14M12 4l-1 3h2z"/><path d="M5 7l-3 6a3 3 0 0 0 6 0L5 7zM19 7l-3 6a3 3 0 0 0 6 0l-3-6z"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="2.4"'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    dollar: svg('<path d="M12 3v18M16.5 7.5c-.8-1.3-2.4-2-4.5-2-2.6 0-4.3 1.3-4.3 3.2 0 4.6 9 2.4 9 7 0 2-1.9 3.3-4.6 3.3-2.3 0-4-.8-4.8-2.3"/>', 'stroke-width="2.2"'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    send: svg('<path d="M5 12h13M13 6l6 6-6 6"/>', 'stroke-width="2.2"'),
    star: svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
    arrow: svg('<path d="M9 6l6 6-6 6"/>'),
    flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
    plane: svg('<path d="M3 13l18-7-7 18-2.5-8.5z"/>'),
    shield: svg('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>'),
    laptop: svg('<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    witness: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/><path d="M15.5 14.8l1 2.2 2.3.3-1.7 1.6.4 2.3-2-1.1"/>'),
  };

  // Flat courtroom figures in the design-system palette.
  const person = (body, extra = "", hair = "") =>
    `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 64c0-14 9.5-22 22-22s22 8 22 22z" fill="${body}"/>${extra}<circle cx="32" cy="25" r="12" fill="#EAD7C3"/><circle cx="27.5" cy="25" r="1.4" fill="#2B2F36"/><circle cx="36.5" cy="25" r="1.4" fill="#2B2F36"/><path d="M28.5 30q3.5 2.6 7 0" fill="none" stroke="#2B2F36" stroke-width="1.4" stroke-linecap="round"/>${hair}</svg>`;
  const FIGURE = {
    // judge: robe, white collar, grey judicial wig
    judge: person("#2B2F36", '<path d="M26 42l6 9 6-9z" fill="#FFFFFF"/>', '<path d="M19 24c-1-10 5-15 13-15s14 5 13 15c-2-5-7-8-13-8s-11 3-13 8z" fill="#C6CCD3"/><circle cx="19.5" cy="27" r="3" fill="#C6CCD3"/><circle cx="44.5" cy="27" r="3" fill="#C6CCD3"/>'),
    // witness: gold jacket, glasses
    witness: person("#C19F7C", '<path d="M28 42l4 6 4-6z" fill="#F3ECE4"/>', '<path d="M21 20c1-7 6-10 11-10s10 3 11 10c-3-3-7-4-11-4s-8 1-11 4z" fill="#7A5A3A"/><circle cx="27.5" cy="25" r="3.2" fill="none" stroke="#2B2F36" stroke-width="1.2"/><circle cx="36.5" cy="25" r="3.2" fill="none" stroke="#2B2F36" stroke-width="1.2"/><path d="M30.7 25h2.6" stroke="#2B2F36" stroke-width="1.2"/>'),
    // you: ribbon-blue hoodie
    defendant: person("#224786", "", '<path d="M20 22c0-8 5-12 12-12s12 4 12 12c-2-2-6-3-12-3s-10 1-12 3z" fill="#62666F"/>'),
  };

  const CONFETTI = [
    [8, 22, -20, "#224786"], [20, 6, 15, "#99B4A3"], [34, 30, 40, "#C19F7C"], [62, 10, -35, "#224786"],
    [76, 28, 25, "#99B4A3"], [88, 8, -10, "#C6CCD3"], [92, 34, 50, "#C19F7C"], [14, 44, 30, "#C6CCD3"],
    [70, 46, -25, "#224786"], [48, 4, 10, "#C6CCD3"],
  ]
    .map(([x, y, r, c]) => `<i style="left:${x}%;top:${y}px;transform:rotate(${r}deg);background:${c}"></i>`)
    .join("");

  // ---------- styles (tokens from the Figma design system, "sampled from the $100 bill") ----------

  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
#layer {
  --ink: #2B2F36; --seal: #62666F; --slate: #949AA5; --paper: #C6CCD3; --line: #DADADC;
  --bill: #F4F5F7; --white: #FFFFFF;
  --blue: #224786; --blue-tint: #E3E9F3;
  --green: #99B4A3; --green-deep: #3E5E4B; --green-tint: #E3ECE6;
  --gold: #C19F7C; --gold-deep: #7A5A3A; --gold-tint: #F3ECE4;
  font-family: Urbanist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px; line-height: 1.45; color: var(--ink); -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; cursor: pointer; }
input { font: inherit; color: var(--ink); }
svg { width: 18px; height: 18px; flex: none; }

/* ---- shells ---- */
.panel-wrap { padding: 16px; }
.panel {
  position: relative; width: 360px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto;
  background: var(--bill); border: 1px solid var(--line); border-radius: 18px; padding: 16px;
  box-shadow: 0 18px 50px rgba(43,47,54,.18), 0 2px 6px rgba(43,47,54,.06);
  display: flex; flex-direction: column; gap: 12px; animation: in .22s ease-out;
}
.page { position: fixed; inset: 0; background: var(--bill); overflow: auto; animation: fade .2s ease-out; }
.page.centered { display: grid; place-items: center; padding: 24px 16px; }
.card-lg {
  position: relative; width: 420px; max-width: 100%; background: var(--white); border: 1px solid var(--line);
  border-radius: 20px; padding: 28px 24px 22px; display: flex; flex-direction: column; gap: 14px; animation: in .25s ease-out;
}

/* ---- type ---- */
.h1 { margin: 0; font-size: 30px; line-height: 1.15; font-weight: 700; letter-spacing: -.01em; }
.h2 { margin: 0; font-size: 22px; line-height: 1.2; font-weight: 700; }
.kicker { margin: 0 0 -8px; font-size: 13px; font-weight: 600; color: var(--blue); }
.muted { margin: 0; color: var(--seal); }
.note { margin: 0; font-size: 13px; color: var(--seal); }
.tiny { font-size: 12px; color: var(--seal); }
.small { font-size: 13px; }
.fine { margin: 0; font-size: 12px; color: var(--seal); }
.center { text-align: center; }
.blue { color: var(--blue); font-weight: 600; }
.row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

/* ---- cards ---- */
.card { background: var(--white); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 600; color: var(--seal); padding: 2px 2px 0; }
.icon-btn { border: 0; background: none; padding: 4px; border-radius: 8px; color: var(--seal); display: grid; }
.icon-btn:hover { background: var(--white); color: var(--ink); }
.amount { display: flex; align-items: baseline; gap: 6px; margin: 2px 0 8px; }
.amount b { font-size: 34px; line-height: 1; font-weight: 700; color: var(--blue); letter-spacing: -.02em; }
.amount span { color: var(--seal); font-size: 13px; }
.bar { height: 6px; border-radius: 99px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--blue); border-radius: inherit; transition: width .6s ease-out; }
.bar-foot { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: var(--seal); }
.goal-line { display: flex; flex-direction: column; gap: 8px; font-weight: 600; font-size: 13px; }
.hint { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--gold-deep); }
.hint svg { width: 20px; height: 20px; padding: 3px; border-radius: 50%; background: var(--gold); color: var(--white); }
.hint.box { background: var(--gold-tint); border-radius: 12px; padding: 12px 14px; }
.wish { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--seal); background: var(--bill); }
.thumb { width: 34px; height: 34px; border-radius: 8px; background: var(--line); flex: none; }
.row-link { display: flex; align-items: center; gap: 12px; text-align: left; width: 100%; }
.row-link span { flex: 1; display: flex; flex-direction: column; }
.row-link small { color: var(--seal); font-size: 12px; }
.row-link:hover { border-color: var(--paper); }

/* ---- buttons ---- */
.stack { display: flex; flex-direction: column; gap: 8px; }
.btn { width: 100%; border-radius: 10px; padding: 11px 16px; font-weight: 600; font-size: 15px; border: 1px solid transparent; }
.btn.primary { background: var(--ink); color: var(--white); }
.btn.primary:hover { background: #3a3f48; }
.btn.outline { background: var(--white); border-color: var(--paper); }
.btn.outline:hover { border-color: var(--seal); }
.link { border: 0; background: none; padding: 4px; font-size: 13px; color: var(--seal); align-self: center; }
.link:hover { color: var(--ink); text-decoration: underline; }
.chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--paper); background: var(--white); border-radius: 99px; padding: 4px 11px; font-size: 13px; font-weight: 500; }
.chip svg { width: 14px; height: 14px; }
.chip.on { background: var(--blue-tint); border-color: var(--blue); color: var(--blue); }
.chip.gold { background: var(--gold-tint); border-color: transparent; color: var(--gold-deep); padding: 2px 9px; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.btn:focus-visible, .link:focus-visible, .chip:focus-visible, .chip-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

/* ---- forms ---- */
.two { display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--seal); }
label input { border: 1px solid var(--paper); border-radius: 10px; padding: 9px 11px; background: var(--white); outline: none; font-size: 14px; }
label input:focus { border-color: var(--blue); }

/* ---- seals ---- */
.seal { width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center; align-self: center; position: relative; }
.seal svg { width: 26px; height: 26px; }
.seal.blue { background: var(--blue); color: var(--white); }
.seal.green { background: var(--green); color: var(--green-deep); }
.seal.soft { background: var(--blue-tint); color: var(--blue); }
.seal.plain { background: var(--bill); color: var(--ink); border: 1px solid var(--line); }
.seal.ring::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 1.5px dashed currentColor; opacity: .5; }
.seal.blue.ring::after { border-color: var(--blue); }
.seal.green.ring::after { border-color: var(--green-deep); }
.confetti { position: absolute; inset: 0 0 auto; height: 60px; pointer-events: none; }
.confetti i { position: absolute; width: 7px; height: 11px; border-radius: 2px; opacity: .85; }

/* ---- verdict ---- */
.reason { border-radius: 12px; padding: 12px 14px; font-size: 14px; }
.reason.r-blue { background: var(--blue-tint); }
.reason.r-green { background: var(--green-tint); }
.reason.r-plain { background: var(--bill); border: 1px solid var(--line); }

/* ---- deliberating ---- */
.checks { list-style: none; margin: 4px 0 6px; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.checks li { display: flex; gap: 10px; align-items: flex-start; color: var(--slate); }
.checks li > span:last-child { display: flex; flex-direction: column; }
.checks li b { font-weight: 600; }
.checks li small { font-size: 12px; color: var(--seal); }
.tick { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--paper); flex: none; margin-top: 1px; position: relative; }
.checks li.active { color: var(--ink); }
.checks li.active .tick { border: 1.5px dashed var(--blue); animation: spin 1.6s linear infinite; }
.checks li.done { color: var(--ink); }
.checks li.done .tick { background: var(--blue); border-color: var(--blue); }
.checks li.done .tick::after { content: ""; position: absolute; left: 5px; top: 2px; width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }

/* ---- courtroom ---- */
.court { display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; font-size: 14px; color: var(--seal); }
.chip-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--paper); background: var(--white); border-radius: 10px; padding: 7px 12px; font-weight: 600; font-size: 13px; color: var(--ink); }
.chip-btn svg { width: 14px; height: 14px; }
.chip-btn:hover { border-color: var(--seal); }
.court-stage { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 8px 16px 28px; }
/* courtroom scene above the chat */
.scene {
  position: relative; width: 660px; max-width: 100%; height: 150px; flex: none; overflow: hidden;
  background: linear-gradient(var(--white) 0 74%, var(--line) 74% 75%, var(--bill) 75%);
  border: 1px solid var(--line); border-radius: 20px;
  display: grid; grid-template-columns: 1fr 1.3fr 1fr; align-items: end; padding: 0 28px;
}
.seal-wall { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: var(--blue-tint); color: var(--blue); }
.seal-wall svg { width: 16px; height: 16px; }
.spot { display: flex; flex-direction: column; align-items: center; }
.spot .figure svg { opacity: .55; transition: opacity .25s; }
.spot.talking .figure svg { opacity: 1; }
.figure { position: relative; width: 52px; height: 52px; margin-bottom: -6px; transition: transform .25s ease-out; }
.figure svg { width: 52px; height: 52px; }
.spot.judge .figure { width: 60px; height: 60px; }
.spot.judge .figure svg { width: 60px; height: 60px; }
.spot.talking .figure { transform: translateY(-5px); }
.bench, .stand, .table { position: relative; display: grid; place-items: center; border-radius: 8px 8px 0 0; }
.bench { width: 190px; height: 52px; background: var(--ink); }
.stand { width: 104px; height: 40px; background: var(--white); border: 1.5px dashed var(--paper); border-bottom: 0; }
.table { width: 120px; height: 34px; background: var(--paper); }
.plate { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: var(--white); color: var(--seal); white-space: nowrap; transition: background .2s, color .2s; }
.bench .plate { background: rgba(255,255,255,.12); color: var(--white); }
.spot.talking .plate { background: var(--blue); color: var(--white); }
.spot.witness.talking .plate { background: var(--gold-deep); }
/* the witness stand is empty until someone is called */
.spot.witness .figure { opacity: 0; transform: translateY(14px); transition: opacity .35s, transform .35s ease-out; }
.spot.witness.called .figure { opacity: 1; transform: none; }
.spot.witness.called.talking .figure { transform: translateY(-5px); }
.spot.witness.called .stand { background: var(--gold-tint); border: 0; }
.speech { position: absolute; top: -6px; right: -10px; display: none; gap: 3px; padding: 5px 7px; background: var(--white); border: 1px solid var(--line); border-radius: 10px 10px 10px 2px; }
.speech i { width: 4px; height: 4px; border-radius: 50%; background: var(--slate); animation: blink 1s infinite; }
.speech i:nth-child(2) { animation-delay: .15s; }
.speech i:nth-child(3) { animation-delay: .3s; }
.spot.thinking .speech { display: flex; }
.chat {
  width: 660px; max-width: 100%; height: min(470px, calc(100vh - 290px)); min-height: 300px; display: flex; flex-direction: column;
  background: var(--white); border: 1px solid var(--line); border-radius: 20px; overflow: hidden;
}
.chat-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.chat-head b { display: block; font-size: 16px; }
.chat-head small { display: block; font-size: 12px; color: var(--seal); }
.av { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; flex: none; }
.av svg { width: 17px; height: 17px; }
.av.judge { background: var(--blue-tint); color: var(--blue); }
.av.gold { background: var(--gold-tint); color: var(--gold-deep); }
.log { flex: 1; overflow-y: auto; padding: 20px 16px 12px; display: flex; flex-direction: column; gap: 10px; }
.log > :first-child { margin-top: auto; }
.msg { display: flex; gap: 10px; align-items: flex-end; max-width: 78%; animation: rise .2s ease-out; }
.msg .bubble { padding: 9px 14px; border-radius: 14px; font-size: 15px; line-height: 1.4; }
.msg.judge .bubble { background: var(--blue-tint); border-bottom-left-radius: 4px; }
.msg.judge .bubble.q { font-weight: 700; }
.msg.me { align-self: flex-end; }
.msg.me .bubble { background: var(--ink); color: var(--white); border-bottom-right-radius: 4px; }
.msg.witness .who { font-size: 12px; font-weight: 700; color: var(--gold-deep); margin: 0 0 3px 2px; }
.msg.witness .who span { font-weight: 500; }
.msg.witness .bubble { background: var(--gold-tint); border-bottom-left-radius: 4px; }
.moment { align-self: center; text-align: center; max-width: 80%; font-size: 12px; font-weight: 600; color: var(--seal); padding: 6px 4px; animation: fade .3s ease-out; }
.typing .bubble { display: flex; gap: 4px; padding: 13px 14px; }
.typing .bubble i { width: 6px; height: 6px; border-radius: 50%; background: var(--slate); animation: blink 1s infinite; }
.typing .bubble i:nth-child(2) { animation-delay: .15s; }
.typing .bubble i:nth-child(3) { animation-delay: .3s; }
.composer { display: flex; gap: 10px; padding: 12px 14px 14px; border-top: 1px solid var(--line); }
.composer input { flex: 1; border: 1.5px solid var(--paper); border-radius: 12px; padding: 11px 14px; font-size: 15px; outline: none; background: var(--white); }
.composer input:focus { border-color: var(--blue); }
.composer input:disabled { background: var(--bill); }
.send { width: 44px; border: 0; border-radius: 12px; background: var(--ink); color: var(--white); display: grid; place-items: center; }
.send:disabled { opacity: .35; cursor: default; }

@keyframes in { from { opacity: 0; transform: translateY(6px); } }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
@keyframes fade { from { opacity: 0; } }
@keyframes blink { 50% { opacity: .3; } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
@media (max-width: 520px) { .scene { padding: 0 8px; height: 130px; } .bench { width: 120px; } .stand, .table { width: 84px; } }
@media (max-height: 620px) { .scene { display: none; } }
@media (max-width: 520px) { .msg { max-width: 90%; } .h1 { font-size: 26px; } }
`;
  }
})();
