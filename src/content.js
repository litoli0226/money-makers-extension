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
    const imgEl = document.querySelector("#landingImage, #imgBlkFront, #main-image-container img");
    const image = imgEl?.getAttribute("data-old-hires") || imgEl?.currentSrc || imgEl?.src || "";
    return title ? { items: [{ title, price, image }], total: price } : null;
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
        image: row.querySelector("img.sc-product-image, .sc-product-image img, img")?.src || "",
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
    const imgs = [...document.querySelectorAll(".item-image img, .lineitem-image img")].map((el) => el.src);
    const items = titles.length ? titles.map((title, i) => ({ title, image: imgs[i] || "" })) : [{ title: "Your order" }];
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

  // After the extension is reloaded, the copy of this script in an already-open
  // tab is cut off: chrome.* calls throw "Extension context invalidated". Some
  // Chromium browsers (Dia) still report chrome.runtime.id, so actually try a call.
  function alive() {
    try {
      return !!chrome.runtime?.getManifest?.() && !!chrome.storage?.local;
    } catch {
      return false;
    }
  }

  const getStore = () => chrome.storage.local.get({ settings: {}, history: [], neverItems: [], wishlist: [] });

  const savedTotal = (settings, history) =>
    (Number(settings.savedSoFar) || 0) +
    history.filter((h) => h.outcome === "saved" || h.outcome === "kept").reduce((t, h) => t + (h.total || 0), 0);

  // Guest mode (switch "guestHistory", default "hold"): an MVP trial's records
  // wait here and are written to history only if the defendant sets a savings
  // goal. Leave the page without one, and the court forgets the case.
  const guest = { on: false, pending: [], wish: [] };
  // Guest mode is a fresh session every trial: a goal or savings from an
  // earlier trial don't count. Only a goal set during this trial does.
  function startGuest(settings) {
    guest.on = settings.guestHistory !== "keep";
    guest.session = guest.on; // stays true for the whole trial, even after a goal is set
    guest.goal = null;
    guest.pending = [];
    guest.wish = [];
  }
  // The profile an MVP screen should show: in guest mode, only this trial.
  function mvpProfile(settings, history) {
    if (guest.session) return { goal: guest.goal, saved: guest.saved || 0 };
    return profileFrom(settings, history);
  }
  async function flushGuest() {
    if (!guest.on) return;
    guest.on = false;
    const { history, wishlist } = await getStore();
    await chrome.storage.local.set({ history: [...guest.pending, ...history].slice(0, 200), wishlist: [...guest.wish, ...wishlist].slice(0, 100) });
    guest.pending = [];
    guest.wish = [];
  }

  async function logOutcome(item, outcome, extra = {}) {
    if (guest.on && extra.format === "mvp") {
      guest.pending.unshift({ date: Date.now(), title: item.label, total: item.total, outcome, ...extra });
      return;
    }
    const { history } = await getStore();
    history.unshift({ date: Date.now(), title: item.label, total: item.total, outcome, ...extra });
    await chrome.storage.local.set({ history: history.slice(0, 200) });
  }

  async function addToWishlist(item) {
    if (guest.on) {
      guest.wish.unshift({ date: Date.now(), title: item.label, total: item.total, url: location.href });
      return;
    }
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

  // While the court is on screen, Amazon's page underneath doesn't scroll.
  let savedOverflow = null;
  function lockPage(on) {
    const el = document.documentElement;
    if (on && savedOverflow === null) {
      savedOverflow = [el.style.overflow, document.body?.style.overflow || ""];
      el.style.overflow = "hidden";
      if (document.body) document.body.style.overflow = "hidden";
    } else if (!on && savedOverflow !== null) {
      el.style.overflow = savedOverflow[0];
      if (document.body) document.body.style.overflow = savedOverflow[1];
      savedOverflow = null;
    }
  }
  // A small note in the corner that doesn't block anything.
  function toast(text) {
    const el = document.createElement("div");
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;max-width:320px;padding:12px 14px;border-radius:12px;background:#2B2F36;color:#fff;font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2)";
    el.textContent = text;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
  function clearUI() {
    layer.innerHTML = "";
    host.style.inset = "auto";
    lockPage(false);
  }
  // Quick check sits top-right over the page. Everything else takes over the page.
  function showPanel(html) {
    host.style.inset = "0 0 auto auto";
    layer.innerHTML = `<div class="panel-wrap"><div class="panel" role="dialog">${html}</div></div>`;
  }
  // Centered over a Slate scrim (design system: "Backdrop behind takeover"). Used by the court notice.
  function showCenteredPanel(html, cls = "") {
    host.style.inset = "0";
    lockPage(true);
    layer.innerHTML = `<div class="scrim"><div class="panel ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  }
  function showPage(html, cls = "") {
    host.style.inset = "0";
    lockPage(true);
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
    // No goal: milestones every $100. "Before" counts toward the next one
    // above what's saved now; "after" toward the next one above the new total.
    const step = 100;
    const nextOf = (v) => (Math.floor(v / step) + 1) * step;
    const passed = Math.floor(after / step) > Math.floor(before / step) ? Math.floor(after / step) * step : 0;
    return {
      hasGoal: false,
      target: nextOf(before),
      targetAfter: nextOf(after),
      before,
      after,
      pctBefore: Math.round((before / nextOf(before)) * 100),
      pctAfter: Math.round((after / nextOf(after)) * 100),
      left: Math.max(nextOf(before) - after, 0),
      milestone: passed ? `you're past $${passed} saved.` : "",
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
      <div class="amount"><b>${money(value)}</b><span>· next milestone ${money(mode === "after" ? m.targetAfter : m.target)}</span></div>
      ${bar(pct)}
      <div class="bar-foot"><span>${pct}% of the way</span>${mode === "before" ? `<span class="blue">Skip it → ${m.pctAfter}%</span>` : ""}</div>
    </div>`;
  }

  // Slim goal line on the verdict screens. With an item, also shows what
  // saving it would do ("Saving $48 gets you to 8%.").
  function goalLine(profile, item = null, note = "") {
    const g = profile.goal;
    if (!g?.target) return "";
    const pct = Math.min(100, Math.round((profile.saved / g.target) * 100));
    const after = item ? Math.min(100, Math.round(((profile.saved + (item.total || 0)) / g.target) * 100)) : null;
    return `<div class="card goal-line"><div class="row-between"><span>${esc(g.name)}</span><span class="blue">${money(profile.saved)} of ${money(g.target)}</span></div>${bar(pct)}${
      after !== null ? `<small class="goal-note">${esc(note || `Saving ${money(item.total, item.currency)} gets you to ${after}%.`)}</small>` : ""
    }</div>`;
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
    on("[data-act=court]", () => (trialFormat(settings) === "mvp" ? startMvpTrial(item, settings, history) : startTrial(item, settings, history)));
    on("[data-act=never]", async () => {
      const { neverItems } = await getStore();
      await chrome.storage.local.set({ neverItems: [...new Set([item.label, ...neverItems])].slice(0, 500) });
      await logOutcome(item, "never");
      proceedWithPurchase();
    });
  }

  // ---------- Court notice (MVP consent screen) ----------
  // Matthew's quick check panel, restyled: same spot, same three ways out, in the
  // courtroom voice. Copy lives in MVP_LINES.notice in src/script.js.

  // Who sees the defendant's words in AI mode (for the disclosure). Null in scripted mode.
  function aiProvider(settings) {
    if (settings.mode === "anthropic") return "Anthropic (Claude), through the team's API key";
    if (settings.mode === "openrouter") {
      const model = settings.openrouterModel || "anthropic/claude-haiku-5.5";
      return `OpenRouter, which passes them to the model ${model}`;
    }
    return null;
  }

  // The judge's head, cropped from the cast figure, for chat avatars.
  let judgeFace = null;
  const faceOf = (fig) => fig.replace('viewBox="0 0 64 64"', 'viewBox="12 5 40 40"');
  const judgeAv = () => (judgeFace ? `<span class="av face">${judgeFace}</span>` : `<span class="av judge">${ICON.scale}</span>`);

  // Gas: a pump, then one tank gauge per tank (at most 8), the last one filled
  // to its fraction. Below half a tank, one gauge filled to that share.
  function gasIcons(gas) {
    const fills = [];
    if (gas.unit === "gallon") fills.push(Math.min(gas.raw, 1));
    else {
      let left = gas.n;
      while (left > 0 && fills.length < 8) { fills.push(Math.min(left, 1)); left -= 1; }
    }
    const more = gas.unit === "tank" && gas.n > 8 ? `<span class="gas-more">+${Math.ceil(gas.n - 8)}</span>` : "";
    return `<span class="pump">${ICON.pump}</span>` + fills.map((f) => `<span class="tank"><span style="width:${Math.max(Math.round(f * 100), 6)}%"></span></span>`).join("") + more;
  }

  // Where the order is going, from Amazon's "Deliver to" line ("Pittsburgh 15213").
  function deliveryState() {
    const t = document.querySelector("#glow-ingress-line2, #nav-global-location-slot")?.textContent || "";
    const zip = t.match(/\b(\d{5})\b/)?.[1];
    return zip ? globalThis.gicPrices.stateFromZip(zip) : null;
  }

  // Who sees the answers, short form, for the notice's privacy line.
  function aiShort(settings) {
    if (settings.mode === "anthropic") return "Anthropic (Claude)";
    if (settings.mode === "openrouter") return `OpenRouter (${(settings.openrouterModel || "anthropic/claude-haiku-5.5").split("/").pop()})`;
    return null;
  }

  function showCourtNotice(item, settings, history) {
    const N = globalThis.gicMvpLines.notice;
    const cast = globalThis.gicCast.castCourt();
    const short = globalThis.gicShortName(item.label);
    const the = item.items.length > 1 ? "this cart" : `the ${short}`;
    const price = money(item.total, item.currency);
    startGuest(settings);
    const G = globalThis.gicPrices;
    const usd = !item.currency || item.currency === "USD";
    const gp = G.gasPrice(deliveryState());
    const gas = usd ? G.gasEquivalent(item.total, gp.perGallon) : null;
    const noun = G.itemNoun(item.label); // "a candle", "headphones" or null
    const what =
      item.items.length > 1 ? `these ${item.items.length} items` : !noun ? "this item" : /^an? /.test(noun) ? `this ${noun.replace(/^an? /, "")}` : `these ${noun}`;
    showCenteredPanel(`
      <button class="icon-btn notice-x" data-act="close" aria-label="Close">${ICON.x}</button>
      <div class="summons-head">
        <span class="av face ring">${faceOf(cast.judge)}</span>
        <b>${esc(N.kicker)}</b>
      </div>
      <div class="summons-main">
        <h2 class="h2 charge">${esc(N.charge(gas, what, price))}</h2>
        <div class="evidence">
          <span class="ev-price">${esc(price)}</span>
          ${gas ? `<span class="gas-row" aria-hidden="true">${gasIcons(gas)}</span>` : ""}
        </div>
      </div>
      <p class="muted summons-body">${esc(N.body())}</p>
      <div class="stack">
        <button class="btn primary court-go" data-act="court"><span>${esc(N.start)}</span><span class="time">${ICON.clock}${esc(N.time)}</span></button>
        <button class="btn outline" data-act="skip">${esc(N.skip)}</button>
      </div>
      <button class="link notice-never" data-act="never">${esc(N.never)}</button>
      <p class="notice-privacy">${esc(N.privacy({ ai: aiShort(settings), guest: guest.on }))} <a href="#" data-act="privacy">${esc(N.privacyLink)}</a></p>`, "notice summons");
    on("[data-act=privacy]", (e) => {
      e?.preventDefault?.();
      chrome.runtime.sendMessage({ type: "openPrivacy" });
    });
    $("[data-act=court]").focus();
    const skip = async (outcome) => {
      await logOutcome(item, outcome, { where: "notice", format: "mvp" });
      proceedWithPurchase();
    };
    on("[data-act=close]", () => skip("not now"));
    on("[data-act=skip]", () => skip("skipped court"));
    on("[data-act=court]", () => startMvpTrial(item, settings, history, cast));
    on("[data-act=never]", async () => {
      const { neverItems } = await getStore();
      await chrome.storage.local.set({ neverItems: [...new Set([item.label, ...neverItems])].slice(0, 500) });
      await skip("never");
    });
  }

  // ---------- 03 / 11 Saved ----------

  async function saveIt(item, settingsAtStart, historyAtStart, where, style, transcript = [], extra = {}) {
    // Read again: a goal may have been set since the trial started.
    const { settings, history } = await getStore();
    const profile = extra.format === "mvp" ? mvpProfile(settings, history) : profileFrom(settings, history); // before this save
    const m = goalMath(profile, item);
    await logOutcome(item, "saved", { where, transcript, ...extra });
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
      ${guest.on ? "" : `<div class="card wish">${item.items[0]?.image && !/loading|spinner|pixel|\.gif/i.test(item.items[0].image) ? `<img class="thumb" src="${esc(item.items[0].image)}" alt="" />` : ""}<span>${esc(short)} is on your Guilty If Charged wishlist.${by ? ` Revisit it after ${esc(by)}.` : ""}</span></div>`}
      <button class="btn primary" data-act="done">Done</button>`;
    if (style === "panel") showPanel(html);
    else showPage(`<div class="card-lg">${html}</div>`, "centered");
    on("[data-act=done]", clearUI);
    on("[data-act=goal]", () => showGoalSheet(item, profile.saved + (item.total || 0), style));
  }

  // ---------- 16.1 Goal sheet ----------

  function showGoalSheet(item, saved, style, onDone = null) {
    const kinds = [
      ["Trip", ICON.plane],
      ["Safety net", ICON.shield],
      ["Laptop", ICON.laptop],
      ["Something else", ICON.plus],
    ];
    const html = `
      <h2 class="h2">What are you saving for?</h2>
      <div class="chips">${kinds.map(([k, i], n) => `<button class="chip${n === 0 ? " on" : ""}" data-kind="${k}">${i}${k}</button>`).join("")}</div>
      <div class="two">
        <label>Name<input id="gname" value="Spring break" /></label>
        <label>Amount in dollars<span class="money-in"><span aria-hidden="true">$</span><input id="gamount" inputmode="decimal" placeholder="600" aria-describedby="gamountErr" /></span><small id="gamountErr" class="field-err" role="alert"></small></label>
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
      const pct = (v) => Math.min(100, Math.round((v / a) * 100));
      $("#gpreview").textContent = !(a > 0)
        ? ""
        : saved > 0
          ? `${money(saved)} of ${money(a)} already done. That's ${pct(saved)}%.`
          : item?.total
            ? `Skipping this ${money(item.total, item.currency)} would get you ${pct(item.total)}% of the way.`
            : "";
    };
    amount.addEventListener("input", () => {
      // Numbers only: drop anything else as it's typed, and say why.
      const clean = amount.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
      $("#gamountErr").textContent = clean !== amount.value ? "Numbers only, like 600." : "";
      if (clean !== amount.value) amount.value = clean;
      preview();
    });
    for (const chip of layer.querySelectorAll("[data-kind]")) {
      chip.onclick = () => {
        layer.querySelectorAll("[data-kind]").forEach((c) => c.classList.toggle("on", c === chip));
        const k = chip.dataset.kind;
        name.value = k === "Trip" ? "Spring break" : k === "Something else" ? "" : k;
        name.focus();
      };
    }
    on("[data-act=later]", () => (onDone ? onDone(null) : clearUI()));
    on("[data-act=savegoal]", async () => {
      if (!name.value.trim()) return name.focus();
      if (!(Number(amount.value) > 0)) {
        $("#gamountErr").textContent = "Enter an amount, like 600.";
        return amount.focus();
      }
      const { settings } = await getStore();
      const goal = { name: name.value.trim(), amount: Number(amount.value) };
      await chrome.storage.local.set({ settings: { ...settings, goalName: goal.name, goalAmount: String(goal.amount) } });
      if (guest.session) guest.goal = { name: goal.name, target: goal.amount, by: null };
      await flushGuest(); // a goal turns a guest's case into a kept case
      onDone ? onDone(goal) : clearUI();
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
    const isMvp = stage.startsWith("mvp_") || stage === "gift_check";
    return isMvp ? globalThis.gicScriptedMvp(stage, ctx) : globalThis.gicScripted(stage, ctx);
  }

  async function startTrial(item, settings, history) {
    const profile = profileFrom(settings, history);
    const short = globalThis.gicShortName(item.label);
    const transcript = [];
    const state = { answers: [], round: 1, totalRounds: flow.RULES.rounds, witnessCalled: false, witness: null };
    let warned = false;
    const cast = globalThis.gicCast.castCourt();
    log("Cast:", cast.ids);

    showPage(`
      <div class="topbar"><span id="round"></span><button class="chip-btn" data-act="leave">Leave trial ${ICON.x}</button></div>
      <div class="court-stage">
        <div class="scene" id="scene" aria-hidden="true">
          <div class="seal-wall">${ICON.scale}</div>
          <div class="spot witness" data-who="witness">
            <div class="figure">${cast.witness}<span class="speech"><i></i><i></i><i></i></span></div>
            <div class="stand"><span class="plate">Witness stand</span></div>
          </div>
          <div class="spot judge" data-who="judge">
            <div class="figure">${cast.judge}<span class="speech"><i></i><i></i><i></i></span></div>
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

  // ---------- Guest-trial MVP (branch guest-trial-mvp) ----------
  //
  // The team's MVP spine (rules doc R6): name -> item + "how" -> objection once if
  // it hears a reason -> witness -> respond -> deliberate -> verdict + sign-up.
  // The classic trial above stays as it was; Settings -> Trial format switches.

  const trialFormat = (settings) => settings.trialFormat || "mvp";
  const TITLES = ["Mr.", "Mrs.", "Ms.", "Mx."];

  // "Meet the judge": a screen of its own between the court notice and the
  // courtroom. All rise, the judge rises behind the bench, asks the defendant's
  // name; the title dropdown sits beside a fixed "Moneybags". Start = gavel.
  // Resolves with the title, or null if they leave.
  function meetTheJudge(cast, L, item) {
    return new Promise((resolve) => {
      showPage(`
        <div class="topbar"><span></span><button class="chip-btn" data-act="door-leave">Leave ${ICON.x}</button></div>
        <div class="door">
          <p class="door-rise">All rise.</p>
          <div class="door-judge">
            <div class="door-fig">${cast.judge}</div>
            <div class="door-bench"><span class="plate">The judge</span></div>
          </div>
          <div class="door-ask">
            <p class="bubble q">${esc(L.name)}</p>
            <form class="gov-form" id="namePick" novalidate>
              <div class="gov-top"><span>FORM GIC-1</span><span>Rev. 11/26</span></div>
              <fieldset>
                <legend>Defendant information</legend>
                <p class="gov-note">Please complete all required fields (*).</p>
                <div class="gov-row">
                  <label class="gov-field">Title *
                    <select id="title" required>
                      <option value="" selected>-- Select --</option>${TITLES.map((t) => `<option>${esc(t)}</option>`).join("")}
                    </select>
                  </label>
                  <label class="gov-field grow">Last name
                    <input id="surname" value="Moneybags" readonly aria-readonly="true" aria-describedby="surnameHelp" />
                    <small id="surnameHelp">Not editable</small>
                  </label>
                </div>
              </fieldset>
              <div class="gov-actions"><button class="gov-btn" disabled>Start</button></div>
            </form>
          </div>
          <p class="door-gavel" aria-live="polite"></p>
        </div>`, "meet");
      const sel = $("#title");
      const btn = $("#namePick button");
      sel.addEventListener("keydown", (e) => e.stopPropagation());
      sel.onchange = () => (btn.disabled = !sel.value);
      // The joke: it looks like a field you can fill in. It isn't.
      const sur = $("#surname");
      const nope = () => {
        sur.parentElement.classList.remove("nope");
        void sur.offsetWidth;
        sur.parentElement.classList.add("nope");
        const lines = ["You cannot change your own last name.", "Please don't try to change your last name. We know who you are."];
        nope.n = (nope.n || 0) + 1;
        $("#surnameHelp").textContent = lines[Math.min(nope.n, lines.length) - 1];
      };
      sur.addEventListener("mousedown", nope);
      sur.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key !== "Tab") nope(); });
      setTimeout(() => sel.focus(), 1900); // after the judge has risen
      on("[data-act=door-leave]", () => {
        logOutcome(item, "left", { where: "meet the judge", format: "mvp" });
        pendingButton = null;
        clearUI();
        if (pageType() === "checkout") location.href = `${location.origin}/cart`;
        resolve(null);
      });
      $("#namePick").onsubmit = async (e) => {
        e.preventDefault();
        if (!sel.value) return sel.focus();
        sel.disabled = btn.disabled = true;
        const door = layer.querySelector(".door");
        sur.disabled = true;
        const noun = globalThis.gicPrices.itemNoun(item.label);
        const versus = item.items.length > 1 ? "the cart" : noun ? `the ${noun.replace(/^an? /, "")}` : globalThis.gicShortName(item.label);
        door.querySelector(".door-bench .plate").textContent = `${sel.value} Moneybags v. ${versus}`;
        door.querySelector(".door-gavel").textContent = "Court is in session.";
        door.classList.add("gavel");
        await wait(1100);
        resolve(sel.value);
      };
    });
  }

  async function startMvpTrial(item, settings, history, castFromNotice = null) {
    const L = globalThis.gicMvpLines;
    const short = globalThis.gicShortName(item.label);
    // R17: the guest trial reads the answers and the price, not the goal.
    const profile = { goal: null, saved: 0 };
    const transcript = [];
    const state = { answers: [], objected: 0, witness: null, gift: null, title: "", inputs: 0, startedAt: Date.now() };
    const cast = castFromNotice || globalThis.gicCast.castCourt(); // same judge as on the court notice
    log("Cast:", cast.ids);
    state.cast = cast.ids;
    if (!castFromNotice) startGuest(settings); // the notice already did when shown
    judgeFace = faceOf(cast.judge);
    let warned = false;
    let howStep = false; // the live hint only runs on "how" questions

    // ----- 1. Meet the judge: the title pick is the doorway into court -----
    state.title = await meetTheJudge(cast, L, item);
    if (state.title == null) return; // left at the door
    const exhibit = item.items.length === 1 ? item.items[0] : null;
    // Amazon's lazy-load spinners and 1-px placeholders aren't photos.
    const isPhoto = (u) => /^https?:|^data:image\/svg/.test(u || "") && !/loading|spinner|transparent-pixel|grey-pixel|\.gif(\?|$)/i.test(u);
    const exhibitImg = item.items.map((i) => i.image).find(isPhoto) || "";

    showPage(`
      <div class="topbar"><div class="eta" role="progressbar" aria-label="Time left in your trial"><div class="eta-bar"><i id="etaFill"></i></div><span id="etaText"></span></div><button class="chip-btn" data-act="leave">Leave trial ${ICON.x}</button></div>
      <div class="court-stage">
        <div class="scene" id="scene" aria-hidden="true">
          <div class="seal-wall">${ICON.scale}</div>
          <div class="exhibit in" id="exhibit">
            <span class="ex-text"><small>Exhibit A</small><b>${esc(exhibit ? short : `${item.items.length} items`)}</b><span>${esc(money(item.total, item.currency))}</span></span>
          </div>
          <div class="spot witness" data-who="witness">
            <div class="figure">${cast.witness}<span class="speech"><i></i><i></i><i></i></span></div>
            <div class="stand"><span class="plate">Witness stand</span></div>
          </div>
          <div class="spot judge" data-who="judge">
            <div class="figure">${cast.judge}<span class="speech"><i></i><i></i><i></i></span></div>
            <div class="bench"><span class="plate">The judge</span></div>
          </div>
          <div class="spot defendant" data-who="defendant">
            <div class="figure blank">${globalThis.gicCast.blank()}<span class="speech"><i></i><i></i><i></i></span></div>
            <div class="table"><span class="plate">You</span></div>
          </div>
        </div>
        <div class="chat" role="log" aria-label="Courtroom">
          <div class="chat-head"><span class="av judge">${ICON.scale}</span><span><b>The judge</b><small>Hearing your case for ${item.items.length > 1 ? "this cart" : `the ${esc(short)}`}</small></span></div>
          <div class="log" id="log" aria-live="polite"></div>
          <div id="controls"></div>
        </div>
        <p class="fine">${settings.mode === "anthropic" || settings.mode === "openrouter" ? "The judge is an AI. It only hears cases about purchases and can make mistakes." : "The judge only hears cases about purchases."} The verdict is advice. You always decide.</p>
      </div>`, "court");

    const logEl = $("#log");
    const controls = $("#controls");
    const scene = $("#scene");
    const judgeSpot = scene.querySelector(".spot.judge");
    // Time-left bar: an estimate in steps, not a running clock. It only moves
    // forward; an objection adds time to the estimate but never empties the bar.
    // Seconds per step (rough; tune after timing testers, R3).
    const EST = { name: 8, how: 30, objection: 25, gift: 8, witness: 14, advocacy: 20, values: 20, closing: 20, deliberate: 8 };
    // Two "how" answers before the witness, either way: an objection retry or a follow-up.
    const eta = { done: 0, left: ["name", "how", "witness", "advocacy", "values", "closing", "deliberate"], shown: 0 };
    function drawEta(label) {
      const leftSec = eta.left.reduce((t, k) => t + EST[k], 0);
      const frac = eta.done / (eta.done + leftSec || 1);
      eta.shown = Math.max(eta.shown, frac);
      $("#etaFill").style.width = `${Math.round(eta.shown * 100)}%`;
      $("#etaText").textContent =
        label || (leftSec > 100 ? "About 2 minutes left" : leftSec > 60 ? "Under 2 minutes left" : leftSec > 25 ? "About 1 minute left" : leftSec > 10 ? "Under a minute left" : "Almost done");
    }
    const stepDone = (k) => {
      const i = eta.left.indexOf(k);
      if (i < 0) return;
      eta.left.splice(i, 1);
      eta.done += EST[k];
      drawEta();
    };
    const stepAdd = (k) => {
      eta.left.splice(eta.left.length - 2, 0, k);
      drawEta();
    };
    const stepDrop = (k) => {
      eta.left = eta.left.filter((x) => x !== k);
      drawEta();
    };
    stepDone("name"); // done at the door

    // Exhibit A is a text lockup. If the item has a photo and it loads, the
    // lockup gains a thumbnail; if not, nothing changes.
    if (exhibitImg) {
      const probe = new Image();
      probe.onload = () => {
        if (probe.naturalWidth < 2) return;
        const box = document.createElement("span");
        box.className = "ex-img";
        box.appendChild(probe);
        probe.alt = "";
        scene.querySelector("#exhibit")?.prepend(box);
        scene.querySelector("#exhibit")?.classList.add("has-img");
      };
      probe.src = exhibitImg;
    }

    on("[data-act=leave]", () => {
      state.left = true;
      logOutcome(item, "left", { where: "courtroom", format: "mvp", transcript, seconds: secs() });
      pendingButton = null;
      clearUI();
      if (pageType() === "checkout") location.href = `${location.origin}/cart`;
    });

    const secs = () => Math.round((Date.now() - state.startedAt) / 1000);
    const scroll = () => (logEl.scrollTop = logEl.scrollHeight);
    function setSpeaker(who, thinking = false) {
      for (const spot of scene.querySelectorAll(".spot")) {
        spot.classList.toggle("talking", spot.dataset.who === who);
        spot.classList.toggle("thinking", thinking && spot.dataset.who === who);
      }
    }
    function say(role, text, opts = {}) {
      if (!text) return;
      transcript.push({ role, text });
      setSpeaker(role);
      const row = document.createElement("div");
      if (role === "defendant") {
        row.className = "msg me";
        row.innerHTML = `<div class="bubble">${esc(text)}</div>`;
      } else if (role === "witness") {
        row.className = "msg witness";
        row.innerHTML = `<span class="av gold">${ICON.witness}</span><div><div class="who">${esc(state.witness.name)} <span>· ${esc(state.witness.role)}</span></div><div class="bubble">${esc(text)}</div>${
          opts.cite ? `<div class="cite">${esc(opts.cite)}</div>` : ""
        }</div>`;
      } else {
        row.className = "msg judge";
        row.innerHTML = `${judgeAv()}<div class="bubble${opts.question ? " q" : ""}">${esc(text)}</div>`;
      }
      logEl.appendChild(row);
      scroll();
      return row;
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
      row.innerHTML = `${who === "witness" ? `<span class="av gold">${ICON.witness}</span>` : judgeAv()}<div class="bubble"><i></i><i></i><i></i></div>`;
      logEl.appendChild(row);
      scroll();
      return () => row.remove();
    }
    const readPause = (t) => wait(Math.min(1400, 350 + String(t || "").length * 12));
    const fallbackNote = (err) => {
      if (warned) return;
      warned = true;
      moment(`AI court unavailable (${err}). Using the scripted court for now.`);
    };
    const ctx = (extra = {}) => ({
      format: "mvp",
      item: { label: item.label, short, total: item.total, currency: item.currency, items: item.items, site: item.site },
      profile,
      transcript,
      answers: state.answers,
      title: state.title,
      defendant_name: state.title ? `${state.title} Moneybags` : "Moneybags",
      advice: state.advice || "",
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

    // ----- inputs: each returns a promise for what the defendant gave -----

    // Free text (ask_text). The live hint (Settings switch) nudges toward "how".
    function askText(placeholder) {
      return new Promise((resolve) => {
        controls.innerHTML = `
          <p class="live-hint" id="hint" hidden>${esc(L.howPlaceholder)}</p>
          <form class="composer" id="composer">
            <input id="answer" autocomplete="off" placeholder="${esc(placeholder || "Make your case")}" />
            <button class="send" aria-label="Send">${ICON.send}</button>
          </form>`;
        const input = $("#answer");
        const hint = $("#hint");
        scroll(); // the controls take room from the log; keep the last line in view
        input.focus();
        input.addEventListener("keydown", (e) => e.stopPropagation());
        let t;
        input.addEventListener("input", () => {
          if (input.value) setSpeaker("defendant", true);
          if (!howStep || settings.liveHint !== "on") return;
          clearTimeout(t);
          t = setTimeout(() => {
            const v = input.value.trim();
            hint.hidden = !(v.split(/\s+/).length >= 4 && globalThis.gicHowKind(v) !== "mechanism");
          }, 250);
        });
        $("#composer").onsubmit = (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          controls.innerHTML = "";
          // Checked here, before anything is scored or sent to an AI.
          const flag = globalThis.gicSafety?.check(v);
          if (flag) return strike(v, flag).then(() => askText(placeholder).then(resolve));
          state.inputs += 1;
          say("defendant", v);
          resolve(v);
        };
      });
    }

    // Off-limits input: shown struck through, answered by the court, never
    // scored or sent to the AI. Self-harm gets the 988 Lifeline instead.
    async function strike(text, flag) {
      log("Safety flag:", flag);
      state.flags = [...(state.flags || []), flag];
      const row = say("defendant", text);
      transcript[transcript.length - 1].text = "[stricken from the record]"; // never quoted back or sent on
      row?.classList.add(flag === "self_harm" ? "set-aside" : "struck");
      const line = globalThis.gicSafety.lines[flag] || globalThis.gicSafety.lines.violent;
      if (flag === "self_harm") {
        const r = document.createElement("div");
        r.className = "row care";
        r.innerHTML = `<div class="care-card" role="note"><b>You don't have to go through this alone.</b><span>${esc(line)}</span><a href="https://988lifeline.org/" target="_blank" rel="noopener">988lifeline.org</a></div>`;
        logEl.appendChild(r);
        scroll();
        return;
      }
      say("judge", line);
      await readPause(line);
    }

    async function aiStrike(flag) {
      const rows = logEl.querySelectorAll(".msg.me");
      const last = rows[rows.length - 1];
      for (let i = transcript.length - 1; i >= 0; i--) if (transcript[i].role === "defendant") { transcript[i].text = "[stricken from the record]"; break; }
      state.inputs = Math.max(0, state.inputs - 1);
      last?.remove();
      await strike(last?.innerText || "", flag);
    }

    // Buttons (the "button moment": title picker, gift check).
    function askButtons(options, { other = false } = {}) {
      return new Promise((resolve) => {
        controls.innerHTML = `<div class="picker">${options.map((o) => `<button class="chip" data-pick="${esc(o)}">${esc(o)}</button>`).join("")}${
          other ? `<input id="other" placeholder="Or type your own" autocomplete="off" /><button class="chip" data-pick="__other">OK</button>` : ""
        }</div>`;
        const otherEl = $("#other");
        scroll();
        otherEl?.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") layer.querySelector("[data-pick=__other]").click();
        });
        for (const b of layer.querySelectorAll("[data-pick]")) {
          b.onclick = () => {
            const v = b.dataset.pick === "__other" ? (otherEl.value.trim() || "") : b.dataset.pick;
            if (!v) return otherEl.focus();
            controls.innerHTML = "";
            resolve(v);
          };
        }
      });
    }

    await wait(400);

    // ----- 2. Item, price line, "how" -----
    // Joke first (picked here, at random), then the judge reads Exhibit A.
    const joke = globalThis.gicPrices.anecdote(money(item.total, item.currency));
    const r0 = await ask("mvp_item", { joke });
    say("judge", r0.line);
    await readPause(r0.line);
    if (r0.price_line) {
      if (state.left) return;
      judgeSpot.classList.add("eyebrow"); // set_expression: reading the exhibit
      $("#exhibit")?.classList.add("read");
      moment("The judge leans in to read Exhibit A.");
      await wait(900);
      say("judge", r0.price_line);
      await readPause(r0.price_line);
      judgeSpot.classList.remove("eyebrow");
      $("#exhibit")?.classList.remove("read");
      if (state.left) return;
    }
    say("judge", r0.question, { question: true });

    const howAnswer = async (objectionAllowed) => {
      howStep = true;
      const a = await askText(L.howPlaceholder);
      howStep = false;
      const r = await ask("mvp_how", { answer: a, objection_allowed: objectionAllowed, second: state.answers.length > 0 });
      if (r.flag && r.flag !== "none") {
        await aiStrike(r.flag); // the model caught what the local list missed
        return howAnswer(objectionAllowed);
      }
      state.answers.push({ text: a, kind: r.kind, strength: r.strength, engaged: r.engaged !== false, unsure: !!r.unsure, claim: r.claim });
      log("How answer:", r.kind, r.strength, r.claim, "score", flow.score(state));
      return r;
    };

    // The trial is one story in four beats, each from the research:
    //  3. how: the mechanism. A reason ("it's for my girlfriend") draws one
    //     objection that presses for the mechanism (Fernbach et al. 2013).
    //  4. the expert witness, called on the topic the defendant raised, quoting them.
    //  5. advocacy: what would you tell a friend? (hypocrisy induction, first half)
    //  6. values: you'd want to be good to her; what else could $X do for her?
    //     (consistency with their own advice + an opportunity-cost cue)
    //  7. closing: the court says it's about to deliberate and asks a calibrated
    //     "what" question, so the defendant gets one last say.

    // ----- 3. Objection, once, only after a reason (R7) -----
    let r1 = await howAnswer(true);
    if (state.left) return;
    stepDone("how");
    if (flow.mvpAfterHow(state, r1.kind) === "object" && r1.objection) {
      state.objected += 1;
      stepAdd("objection");
      judgeSpot.classList.add("eyebrow"); // set_expression: eyebrow_raised
      moment(r1.kind === "unclear" ? "The judge waits. The pen does not move." : "The judge sets down the pen. One eyebrow rises.");
      await wait(500);
      say("judge", r1.objection, { question: true });
      r1 = await howAnswer(false);
      stepDone("objection");
      judgeSpot.classList.remove("eyebrow");
      if (state.left) return;
    }

    // The judge reacts to a plan given on the first try; after an objection the
    // bridge below is enough (no "noted" filler).
    if (!state.objected && String(r1.acknowledge || "").trim()) {
      say("judge", r1.acknowledge);
      await readPause(r1.acknowledge);
    }

    // ----- optional: gift buttons (C4 switch) -----
    if (settings.giftButtons === "on" && state.answers.some((a) => a.claim === "gift")) {
      stepAdd("gift");
      const g = await ask("gift_check");
      say("judge", g.question, { question: true });
      const pick = await askButtons(["It's a gift", "It's not a gift"]);
      say("defendant", pick);
      state.gift = pick === "It's a gift";
      stepDone("gift");
    }

    // Bridge: says why an expert is coming.
    {
      const line = globalThis.gicScriptedMvp("mvp_bridge", ctx()).line;
      say("judge", line);
      await readPause(line);
      if (state.left) return;
    }

    // ----- 4. Expert witness, called on the defendant's own topic -----
    const { lastWitness = null } = await chrome.storage.local.get({ lastWitness: null });
    state.witness = flow.mvpPickWitness(state, lastWitness);
    chrome.storage.local.set({ lastWitness: state.witness.id });
    log("Witness:", state.witness.id, state.witness.stance);
    const topic = globalThis.gicScriptedMvp("mvp_topic", ctx({ witness: state.witness })).topic;
    moment(`The doors open. The court calls ${topic} to the stand.`);
    const stand = scene.querySelector(".spot.witness");
    stand.classList.add("called");
    stand.querySelector(".plate").textContent = state.witness.name;
    await wait(700);
    const c = await ask("mvp_charge", { witness: state.witness });
    say("judge", c.question, { question: true });
    await readPause(c.question);
    const w = await ask("mvp_witness", { witness: state.witness, charge: c.question }, "witness");
    const finding = w.cite ? w : globalThis.gicFindings.FINDINGS.find((f) => f.id === w.finding_id);
    say("witness", w.says, { cite: finding?.cite });
    await readPause(w.says);
    stepDone("witness");
    if (state.left) return;

    // One scored turn: the judge asks, the defendant answers, flags are struck.
    const turn = async (step, question, placeholder) => {
      say("judge", question, { question: true });
      let a = await askText(placeholder);
      let r = await ask("mvp_respond", { answer: a, question, step });
      while (r.flag && r.flag !== "none") {
        await aiStrike(r.flag);
        a = await askText(placeholder);
        r = await ask("mvp_respond", { answer: a, question, step });
      }
      state.answers.push({ text: a, strength: r.strength, engaged: r.engaged !== false, unsure: !!r.unsure, claim: r.claim, step });
      log(`${step}:`, r.strength, "score", flow.score(state));
      stepDone(step);
      return { a, r };
    };

    // ----- 5. Advocacy: the defendant advises a friend in the same spot -----
    {
      await wait(300);
      const { question } = globalThis.gicScriptedMvp("mvp_advocacy_q", ctx());
      const { a, r } = await turn("advocacy", question, "What you'd tell them");
      if (r.engaged !== false) state.advice = a;
    }
    if (state.left) return;

    // ----- 6. Values: held to their advice, inside something they care about.
    // Skipped after an objection when the C1 switch is on, to keep it short. -----
    if (flow.mvpAskRespond(state, settings)) {
      const { question } = globalThis.gicScriptedMvp("mvp_values_q", ctx());
      await turn("values", question, "Your answer");
    } else stepDrop("values");
    if (state.left) return;

    // ----- 7. Closing: the court signals deliberation, one last say -----
    {
      const { question } = globalThis.gicScriptedMvp("mvp_closing_q", ctx());
      await turn("closing", question, "Your last word to the court");
    }
    if (state.left) return;

    // ----- 6. Deliberate, 7. verdict + sign-up -----
    drawEta("Deliberating");
    return mvpDeliberate(item, settings, history, state, transcript, ctx);
  }

  async function mvpDeliberate(item, settings, history, state, transcript, ctx) {
    const byModel = settings.c2VerdictBy === "model" && settings.mode && settings.mode !== "scripted";
    const ruleVerdict = flow.mvpVerdict(state);
    const n = state.answers.length;
    const steps = [
      [`Reviewing your ${n === 1 ? "answer" : `${n} answers`}`, `${n} answer${n === 1 ? "" : "s"} on the record`],
      ["Considering the expert testimony", state.witness?.name || ""],
      ["Weighing how against why", ""],
    ];
    showPage(`
      <div class="card-lg">
        <div class="seal soft ring">${ICON.scale}</div>
        <h2 class="h2 center">The court is deliberating…</h2>
        <p class="muted center">Hang tight, this takes a few seconds.</p>
        <ul class="checks">${steps.map(([t, s]) => `<li><span class="tick"></span><span><b>${esc(t)}</b>${s ? `<small>${esc(s)}</small>` : ""}</span></li>`).join("")}</ul>
      </div>`, "centered");
    const resP = courtTurn("mvp_verdict", ctx({ verdict: ruleVerdict, verdict_by: byModel ? "model" : "rule", gift: state.gift }), settings);
    for (const li of layer.querySelectorAll(".checks li")) {
      li.classList.add("active");
      await wait(1200);
      li.classList.replace("active", "done");
      await wait(200);
    }
    const res = await resP;
    const verdict = byModel && ["approve", "sleep", "denied"].includes(res.verdict) ? res.verdict : ruleVerdict;
    transcript.push({ role: "judge", text: res.reason });
    const seconds = Math.round((Date.now() - state.startedAt) / 1000);
    log(`MVP trial: ${seconds}s, ${state.inputs} typed inputs, objection ${state.objected ? "yes" : "no"}, verdict ${verdict} (by ${byModel ? "model" : "rule"}, rule said ${ruleVerdict}), score ${flow.score(state)}`);
    const meta = { format: "mvp", cast: state.cast, seconds, inputs: state.inputs, objected: !!state.objected, verdictBy: byModel ? "model" : "rule", ruleVerdict, title: state.title };
    showMvpVerdict(item, settings, history, verdict, res.reason, res.signup, transcript, meta);
  }

  // Verdict titles. Writers (Oli): R15 wording is still open; change it here.
  const MVP_VERDICTS = {
    approve: { title: "Case approved", seal: "green", icon: "check", box: "green", primary: "Continue to checkout", secondary: "Actually, save it instead" },
    sleep: { title: "Sleep on it", seal: "blue", icon: "clock", box: "blue", primary: "Save it for now", secondary: "Buy it anyway" },
    denied: { title: "Case denied", seal: "plain", icon: "scale", box: "plain", primary: "Keep my money", secondary: "Appeal and buy anyway" },
  };

  async function showMvpVerdict(item, settings, history, verdict, reason, signupLine, transcript, meta) {
    const V = MVP_VERDICTS[verdict];
    // Read again: the goal may have just been set from this screen.
    const fresh = await getStore();
    const profile = mvpProfile(fresh.settings, fresh.history);
    const hasGoal = !!profile.goal?.target;
    const price = money(item.total, item.currency);
    // With a goal, the verdict looks like the Figma "court rules" frame: the
    // ruling, the goal bar, and "Save $48" as the main action.
    const primary = hasGoal && verdict !== "approve" ? `Save ${price}` : V.primary;
    const note = meta.goal ? `Goal set. The court will keep count. Saving ${price} gets you to ${Math.min(100, Math.round(((profile.saved + (item.total || 0)) / profile.goal.target) * 100))}%.` : "";
    showPage(`
      <div class="card-lg">
        <div class="seal ${V.seal} ring">${ICON[V.icon]}</div>
        <p class="kicker center">The court rules…</p>
        <h2 class="h1 center">${esc(V.title)}</h2>
        <div class="reason r-${V.box}">${esc(reason)}</div>
        ${hasGoal ? goalLine(profile, item, note)
          : meta.goalSkipped ? "" : `<div class="card signup" id="signup">
          <p class="signup-line">${judgeAv()}<span>${esc(signupLine)}</span></p>
          <button class="btn outline" data-act="goal">Set my goal</button>
          <p class="tiny">Optional.${guest.on ? " Skip it, and the court forgets this case when you leave." : ""}</p>
        </div>`}
        <button class="btn primary" data-act="primary">${esc(primary)}</button>
        <button class="link" data-act="secondary">${esc(V.secondary)}</button>
      </div>`, "centered");
    const { goal: _g, goalSkipped: _s, ...kept } = meta;
    const record = { where: "courtroom", verdict, transcript, ...kept, goalSet: !!meta.goal };
    // The investment step: a goal for next time (the team's goal sheet, Figma 16.1).
    on("[data-act=goal]", async () => {
      const { history: h } = await getStore();
      showGoalSheet(item, mvpProfile(settings, h).saved, "page", (goal) =>
        showMvpVerdict(item, settings, history, verdict, reason, signupLine, transcript, goal ? { ...meta, goal } : { ...meta, goalSkipped: true })
      );
    });

    const goSave = () => saveIt(item, settings, history, "courtroom", "page", transcript, { verdict, ...kept, goalSet: !!meta.goal });
    on("[data-act=primary]", async () => {
      if (verdict === "approve") {
        await logOutcome(item, "approved", record);
        return proceedWithPurchase();
      }
      return goSave();
    });
    on("[data-act=secondary]", async () => {
      if (verdict === "approve") return goSave();
      await logOutcome(item, "bought", record);
      showTotallyOkay({ goal: null });
    });
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
    // R5: a trial starts when the total is at least the minimum (default $1).
    const min = settings.minTotal === undefined || settings.minTotal === "" ? 1 : Number(settings.minTotal);
    if (item.total != null && item.total < min) {
      log(`Skipping: total ${item.total} is under the $${min} minimum.`);
      return false;
    }
    log("Checking in on", item);
    // MVP: straight into the trial unless "Show the quick check first" is on.
    // MVP: the court notice (consent) comes first unless the switch turns it off.
    if (trialFormat(settings) === "mvp") {
      if (settings.courtNotice === "off") startMvpTrial(item, settings, history);
      else showCourtNotice(item, settings, history);
    } else showQuickCheck(item, settings, history);
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
      // After the extension is reloaded in chrome://extensions, the copy of this
      // script already running in an open tab loses its connection (chrome.storage
      // becomes undefined). Don't block checkout; ask for a page refresh instead.
      if (!alive()) {
        log("The extension was reloaded. Refresh this page to bring the court back. Letting this click through.");
        toast("Guilty If Charged was updated. Refresh this page to bring the court back.");
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      pendingButton = btn;
      let shown = false;
      try {
        shown = await maybeCheckIn();
      } catch (err) {
        log("Check-in failed, letting the click through:", err?.message || err);
      }
      if (!shown) proceedWithPurchase(); // nothing to check (or an error), let it through
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
    chevron: svg('<path d="M7 10l5 5 5-5"/>', 'stroke-width="2"'),
    pump: svg('<path d="M5 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h14M5 10h10M15 8l3 2v7a1.5 1.5 0 0 0 3 0V9l-3-3"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    box: svg('<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>'),
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

  // Courtroom figures: the judge and witness change per trial (presets in src/cast.js).
  const FIGURE = { defendant: globalThis.gicCast.defendant() };

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
.page { position: fixed; inset: 0; background: var(--bill); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; animation: fade .2s ease-out; }
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
.two { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 10px; }
.two input { width: 100%; min-width: 0; }
#gpreview:empty { display: none; }
.money-in { position: relative; display: block; }
.money-in > span { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--seal); font-weight: 600; pointer-events: none; }
.money-in input { padding-left: 26px !important; }
.field-err { min-height: 0; font-size: 12px; font-weight: 400; color: #a3262a; }
.field-err:empty { display: none; }
.goal-note { display: block; margin-top: 8px; font-size: 12px; color: var(--seal); }
img.thumb { object-fit: contain; background: var(--white); }
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
  position: relative; width: 660px; max-width: 100%; height: 250px; flex: none; overflow: hidden;
  background: linear-gradient(var(--white) 0 80%, var(--line) 80% 80.6%, var(--bill) 80.6%);
  border: 1px solid var(--line); border-radius: 20px;
  display: grid; grid-template-columns: 1fr 1.3fr 1fr; align-items: end; padding: 0 28px;
}
.seal-wall { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: var(--blue-tint); color: var(--blue); }
.seal-wall svg { width: 16px; height: 16px; }
.spot { display: flex; flex-direction: column; align-items: center; }
.spot .figure svg { opacity: .55; transition: opacity .25s; }
.spot.talking .figure svg { opacity: 1; }
/* Figures are large next to their furniture: their faces carry the scene. */
.figure { position: relative; width: 112px; height: 112px; margin-bottom: -8px; transition: transform .25s ease-out; }
.figure svg { width: 112px; height: 112px; }
.spot.judge .figure { width: 160px; height: 160px; }
.spot.judge .figure svg { width: 160px; height: 160px; }
.figure.blank svg { opacity: .8 !important; }
.spot.talking .figure { transform: translateY(-5px); }
.bench, .stand, .table { position: relative; display: grid; place-items: center; border-radius: 8px 8px 0 0; }
.bench { width: 200px; height: 50px; background: var(--ink); }
.stand { width: 112px; height: 38px; background: var(--white); border: 1.5px dashed var(--paper); border-bottom: 0; }
.table { width: 124px; height: 34px; background: var(--paper); }
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
  width: 660px; max-width: 100%; height: min(440px, calc(100vh - 360px)); min-height: 280px; display: flex; flex-direction: column;
  background: var(--white); border: 1px solid var(--line); border-radius: 20px; overflow: hidden;
}
.chat-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.chat-head b { display: block; font-size: 16px; }
.chat-head small { display: block; font-size: 12px; color: var(--seal); }
.av { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; flex: none; }
.msg.me.struck .bubble { text-decoration: line-through; text-decoration-thickness: 2px; opacity: .55; }
.row.care { display: flex; justify-content: center; }
.care-card { display: flex; flex-direction: column; gap: 6px; max-width: 86%; padding: 14px 16px; border-radius: 14px; background: var(--white); border: 1px solid var(--paper); font-size: 14px; line-height: 1.45; color: var(--ink); }
.care-card b { font-size: 15px; }
.care-card a { color: var(--blue); font-weight: 600; }
.av svg { width: 17px; height: 17px; }
.av.judge { background: var(--blue-tint); color: var(--blue); }
.av.gold { background: var(--gold-tint); color: var(--gold-deep); }
.av.face { background: var(--blue-tint); overflow: hidden; }
.av.face svg { width: 100%; height: 100%; display: block; }
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
/* Stage directions, set like a script: left-aligned, italic, in brackets. */
.moment { align-self: flex-start; text-align: left; max-width: 86%; margin: 4px 0 4px 40px; padding: 2px 0 2px 12px; border-left: 2px solid var(--gold); font-family: Georgia, "Times New Roman", serif; font-style: italic; font-size: 15px; font-weight: 400; color: var(--ink); animation: fade .5s ease-out; }
.moment::before { content: "["; color: var(--gold-deep); }
.moment::after { content: "]"; color: var(--gold-deep); }
.typing .bubble { display: flex; gap: 4px; padding: 13px 14px; }
.typing .bubble i { width: 6px; height: 6px; border-radius: 50%; background: var(--slate); animation: blink 1s infinite; }
.typing .bubble i:nth-child(2) { animation-delay: .15s; }
.typing .bubble i:nth-child(3) { animation-delay: .3s; }
/* ---- disclosure on the court notice ---- */
.keeps { font-size: 12.5px; color: var(--seal); }
.keeps summary { cursor: pointer; font-weight: 600; color: var(--ink); }
.keeps ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 4px; }

/* ---- time-left bar (MVP) ---- */
.eta { display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
.eta-bar { width: 220px; height: 8px; border-radius: 99px; background: var(--line); overflow: hidden; }
.eta-bar i { display: block; height: 100%; width: 0; background: var(--ink); border-radius: 99px; transition: width .6s ease-out; }
.eta span { font-size: 12px; font-weight: 600; color: var(--seal); }

/* ---- court notice (MVP consent) ---- */
.scrim { position: fixed; inset: 0; overscroll-behavior: contain; display: grid; place-items: center; padding: 16px; background: rgba(148, 154, 165, .55); animation: fade .2s ease-out; }
.notice-head { display: inline-flex; align-items: center; gap: 6px; color: var(--ink); }
.notice-head svg { width: 16px; height: 16px; }
.case-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
.case-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.gas { display: flex; align-items: center; gap: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.gas-row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.pump { color: var(--blue); display: grid; place-items: center; margin-right: 2px; }
.pump svg { width: 20px; height: 20px; display: block; }
.tank { width: 26px; height: 14px; border-radius: 4px; border: 1.5px solid var(--blue); padding: 1.5px; display: flex; }
.tank > span { display: block; height: 100%; border-radius: 2px; background: var(--blue); }
.gas-more { font-size: 13px; font-weight: 700; color: var(--blue); }
.gas-eq { font-size: 15px; font-weight: 700; color: var(--blue); }
.gas-note { font-size: 11px; color: var(--seal); }
.panel.notice { position: relative; width: 360px; text-align: left; }
.notice-x { position: absolute; top: 12px; right: 12px; }
.panel.summons { width: 480px; padding: 22px 24px 18px; gap: 14px; border: 1px solid var(--paper); box-shadow: 0 0 0 5px var(--white), 0 0 0 6px var(--line), 0 18px 40px rgba(43,47,54,.18); }
.summons-head { display: flex; align-items: center; gap: 10px; padding-right: 28px; }
.summons-head .av.face { width: 36px; height: 36px; }
.av.face.ring { box-shadow: 0 0 0 2px var(--white), 0 0 0 3px var(--gold); }
.summons-head b { font-size: 12px; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; color: var(--gold-deep); }
/* Question 2/3, evidence 1/3. Stacks on narrow screens. */
.summons-main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 14px; align-items: stretch; }
.evidence { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; padding: 12px 14px; background: var(--white); border: 1px solid var(--line); border-radius: 12px; }
.ev-price { font-size: 22px; font-weight: 700; color: var(--ink); letter-spacing: -.01em; line-height: 1; }
.evidence .gas-row { justify-content: flex-start; }
.evidence .tank { width: 24px; height: 14px; }
.evidence .pump svg { width: 18px; height: 18px; }
.charge { margin: 0; font-size: 20px; line-height: 1.3; text-align: left; align-self: center; }
@media (max-width: 460px) { .summons-main { grid-template-columns: 1fr; } }
.summons-body { margin: -6px 0 2px; text-align: left; font-size: 14px; }
.notice-never { align-self: center; text-align: center; }
.notice-privacy { margin: 0; padding-top: 10px; border-top: 1px solid var(--line); font-size: 12px; line-height: 1.45; color: var(--seal); text-align: left; }
.notice-privacy a { color: var(--blue); text-decoration: underline; }
.notice-ask { display: flex; gap: 12px; align-items: flex-start; }
.notice-ask .h2 { margin: 0 0 4px; }
.notice-ask .muted { margin: 0; }
.case-judge { flex: none; }
.case-judge svg { width: 52px; height: 52px; display: block; }
.court-go { display: flex; align-items: center; justify-content: center; gap: 10px; position: relative; }
.court-go .time { position: absolute; right: 14px; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: rgba(255,255,255,.14); }
.court-go .time svg { width: 13px; height: 13px; }
.case-judge .brow { stroke-width: 1.8; stroke-linecap: round; }
.case-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.case-text b { font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.case-price { font-size: 22px; font-weight: 700; }
/* ---- guest-trial MVP ---- */
.picker { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 14px 14px; border-top: 1px solid var(--line); }
.picker .chip { padding: 8px 14px; font-size: 14px; }
.picker input { flex: 1; min-width: 140px; border: 1.5px solid var(--paper); border-radius: 12px; padding: 8px 12px; font-size: 14px; outline: none; }
.picker input:focus { border-color: var(--blue); }
/* Meet the judge (the doorway into court) */
.page.meet { display: flex; flex-direction: column; background: radial-gradient(ellipse 55% 60% at 50% 42%, var(--white) 0 40%, var(--bill) 75%); }
.door { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 0 16px 64px; }
.door-rise { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; color: var(--seal); animation: fade .6s ease-out both; }
.door-judge { display: flex; flex-direction: column; align-items: center; }
.door-fig { width: 132px; height: 132px; margin-bottom: -14px; animation: judgeRise .9s cubic-bezier(.2,.8,.2,1) .5s both; position: relative; z-index: 0; }
.door-fig svg { width: 132px; height: 132px; }
.door-bench { position: relative; z-index: 1; width: 340px; max-width: 86vw; height: 76px; border-radius: 12px 12px 0 0; background: var(--ink); display: grid; place-items: center; }
.door-bench .plate { font-size: 13px; padding: 4px 12px; background: rgba(255,255,255,.12); color: var(--white); max-width: 90%; overflow: hidden; text-overflow: ellipsis; }
.door-ask { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 420px; max-width: 100%; animation: in .4s ease-out 1.5s both; }
.door-ask { width: 460px; }
.door-ask .bubble { margin: 0; font-size: 17px; font-weight: 600; padding: 12px 16px; background: var(--white); border: 1px solid var(--line); border-radius: 14px; }
/* FORM GIC-1: deliberately plain, like a government web form, so the fixed
   last name reads as a form field you were never allowed to fill in. */
.gov-form { width: 100%; background: var(--white); border: 1px solid var(--paper); border-radius: 4px; padding: 0; font-family: inherit; color: var(--ink); text-align: left; box-shadow: 0 1px 0 var(--line); overflow: hidden; }
.gov-top { display: flex; justify-content: space-between; padding: 5px 10px; background: var(--bill); border-bottom: 1px solid var(--paper); font-size: 10px; font-weight: 600; letter-spacing: .08em; color: var(--seal); }
.gov-form fieldset { margin: 12px 12px 0; padding: 6px 12px 14px; border: 1px solid var(--line); border-radius: 2px; }
.gov-form legend { padding: 0 4px; font-size: 13px; font-weight: 700; }
.gov-note { margin: 0 0 10px; font-size: 12px; color: var(--seal); }
.gov-row { display: flex; gap: 12px; align-items: flex-start; }
.gov-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 700; color: var(--ink); }
.gov-field.grow { flex: 1; }
.gov-form select, .gov-form input { font: 14px/1.2 inherit; font-family: inherit; color: var(--ink); height: 32px; padding: 4px 8px; border: 1px solid var(--slate); border-radius: 2px; background: var(--white); box-shadow: inset 0 1px 2px rgba(43,47,54,.08); outline: none; }
.gov-form select { min-width: 120px; }
.gov-form select:focus, .gov-form input:focus { outline: 2px solid var(--blue); outline-offset: 0; }
.gov-form input[readonly] { background: var(--bill); color: var(--seal); border-style: dashed; cursor: not-allowed; }
.gov-field small { font-size: 11px; font-weight: 400; color: var(--seal); }
.gov-field.nope input { animation: nope .3s; }
.gov-field.nope small { color: #a3262a; }
@keyframes nope { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
.gov-actions { display: flex; justify-content: flex-end; padding: 12px; }
.gov-btn { font: inherit; font-size: 14px; font-weight: 600; color: var(--white); padding: 7px 22px; border: 1px solid var(--ink); border-radius: 2px; background: var(--ink); cursor: pointer; }
.gov-btn:hover:not(:disabled) { background: #3a3f48; }
.gov-btn:disabled { background: var(--line); border-color: var(--paper); color: var(--seal); cursor: default; }
.door-gavel { margin: 0; min-height: 22px; font-size: 18px; font-weight: 700; color: var(--ink); }
.door.gavel .door-bench { animation: thud .35s ease-out; }
.door.gavel .door-gavel { animation: in .3s ease-out; }
.door.gavel .door-ask { opacity: .5; transition: opacity .3s; }
@keyframes judgeRise { from { opacity: 0; transform: translateY(70px); } }
@keyframes thud { 30% { transform: translateY(3px); } }
/* Exhibit A, on the courtroom wall */
.exhibit { position: absolute; top: 10px; left: 12px; z-index: 1; display: flex; align-items: center; gap: 8px; max-width: 220px; padding: 6px 12px; background: var(--white); border: 1px solid var(--line); border-radius: 9px; opacity: 0; transform: translateY(-6px); transition: opacity .4s, transform .4s ease-out; }
.exhibit.in { opacity: 1; transform: none; }
.ex-img { width: 30px; height: 30px; flex: none; border-radius: 7px; background: var(--white); display: grid; place-items: center; overflow: hidden; color: var(--seal); }
.ex-img img { width: 100%; height: 100%; object-fit: contain; }
.exhibit.read { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-tint); transition: box-shadow .3s, border-color .3s; }
.ex-img svg { width: 18px; height: 18px; }
.ex-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.ex-text small { font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--gold-deep); }
.ex-text b { font-size: 11px; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.exhibit.has-img { padding-left: 6px; }
.ex-img { animation: fade .3s ease-out; }
.ex-text span { font-size: 11px; color: var(--seal); }
.name-pick { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
.name-pick .select { position: relative; display: inline-flex; flex-direction: row; align-items: center; gap: 0; }
.name-pick select { appearance: none; -webkit-appearance: none; font: inherit; font-size: 14px; color: var(--ink); background: #fff; border: 1.5px solid var(--paper); border-radius: 12px; padding: 8px 32px 8px 12px; cursor: pointer; outline: none; }
.name-pick select:focus { border-color: var(--blue); }
.name-pick .select svg { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; color: var(--seal); pointer-events: none; }
.name-pick .surname { flex: 1; font-size: 15px; font-weight: 600; color: var(--ink); padding: 8px 2px; }
.name-pick .btn:disabled { opacity: .4; cursor: default; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.live-hint { margin: 0; padding: 8px 14px 0; font-size: 12.5px; font-weight: 600; color: var(--gold-deep); }
.cite { margin-top: 4px; font-size: 11.5px; color: var(--seal); }
.signup { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
.signup-line { margin: 0; display: flex; gap: 10px; align-items: center; font-weight: 600; }
.signup-row { display: flex; gap: 8px; }
.signup-row input { flex: 1; border: 1.5px solid var(--paper); border-radius: 10px; padding: 9px 12px; font-size: 14px; outline: none; }
.signup-row input:focus { border-color: var(--blue); }
.btn.small { width: auto; padding: 9px 14px; }
.spot.judge .brow { stroke: #2B2F36; stroke-width: 1.8; stroke-linecap: round; transition: transform .25s ease-out; transform-box: fill-box; transform-origin: center; }
.spot.judge.eyebrow .brow.r { transform: translateY(-4px) rotate(-24deg); }
.spot.judge.eyebrow .figure svg { opacity: 1; }
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
@media (max-width: 520px) { .scene { padding: 0 8px; height: 170px; } .figure, .figure svg { width: 64px !important; height: 64px !important; } .bench { width: 120px; } .stand, .table { width: 84px; } }
@media (max-height: 620px) { .scene { display: none; } }
@media (max-width: 520px) { .msg { max-width: 90%; } .h1 { font-size: 26px; } }
`;
  }
})();
