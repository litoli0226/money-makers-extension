// Content script: detects the shopping moment, shows the summons, and runs the
// hearing overlay. All UI lives in a shadow root so Amazon's CSS can't touch it
// (and ours can't break Amazon).

(() => {
  if (window.__gicLoaded) return;
  window.__gicLoaded = true;

  const MAX_DEFENSES = 2; // team decision: 1-2 rounds max
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SKIP_REVEAL_MS = 3000; // "skip court" link fades in after this
  const SKIP_HOLD_MS = 1500; // and must be held this long

  // Buttons that mean "I'm buying now". Amazon changes these, so keep a list.
  const BUY_SELECTORS = [
    "#buy-now-button",
    "input[name='proceedToRetailCheckout']",
    "[data-feature-id='proceed-to-checkout-action'] input",
    "input[name='placeYourOrder1']",
    "#submitOrderButtonId input",
    "[data-gic-buy]", // test page
  ];
  // Fallback: match the button's visible label. Covers "Place your order in CAD" etc.
  const BUY_TEXT = /\b(proceed to (retail )?checkout|place (your )?order|buy now|continue to checkout)\b/i;

  let pendingButton = null; // the buy button we intercepted
  let allowNextClick = false;

  const log = (...args) => console.log("[GIC]", ...args);

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
  const money = (s) => {
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
    const price = money(
      firstText([
        "#corePrice_feature_div .a-offscreen",
        "#corePriceDisplay_desktop_feature_div .a-offscreen",
        "#apex_desktop .a-price .a-offscreen",
        ".a-price .a-offscreen",
      ])
    );
    const category = firstText(["#wayfinding-breadcrumbs_feature_div li:last-child a"]);
    return title ? { items: [{ title, price, category }], total: price } : null;
  }

  // Cart rows carry data-producttitle / data-price / data-quantity (checked on live amazon.com/cart, Nov 2026).
  // Subtotal is #sc-subtotal-amount-buybox; Proceed to checkout is input[name=proceedToRetailCheckout].
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
        price: money(row.dataset.price) ?? money(firstText([".a-price .a-offscreen", ".sc-product-price"], row)),
        quantity: parseInt(row.dataset.quantity, 10) || 1,
      });
    }
    const sum = items.reduce((t, i) => t + (i.price || 0) * i.quantity, 0);
    const total = money(firstText(["#sc-subtotal-amount-activecart", "#sc-subtotal-amount-buybox"])) ?? sum;
    return items.length ? { items, total } : null;
  }

  // Find "Order total: CA$12.34" style rows by their text.
  function totalByLabel() {
    const labels = [...document.querySelectorAll("td, span, div, dt, li")].filter(
      (el) => el.children.length <= 2 && /^\s*(order total|total)\s*:?\s*$/i.test(el.textContent)
    );
    for (const el of labels) {
      const row = el.closest(".order-summary-grid, tr, li, .a-row, [class*=row], div");
      const n = money(row?.textContent.replace(el.textContent, ""));
      if (n) return n;
    }
    return null;
  }

  // Order page markup isn't verified yet, so fall back to text matching.
  function scrapeCheckout() {
    // Checked on live amazon.com Place Your Order page (Nov 2026). Two tables exist: a hidden
    // USD "marketplace" one and the visible "transactional" one in the shopper's currency.
    const totalText = firstText([
      "#subtotals-transactional-table .grand-total-cell",
      "#subtotals-marketplace-table .grand-total-cell",
      ".grand-total-cell",
      ".grand-total-price",
      "[data-testid='order-summary-total']",
    ]);
    const total = money(totalText) ?? totalByLabel();
    const currency = (totalText.match(/\b(USD|CAD|EUR|GBP|AUD)\b/) || [])[1];
    const titles = [...document.querySelectorAll(".item-title, .lineitem-title-text")]
      .map((el) => el.textContent.trim())
      .filter(Boolean);
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

  const getStore = () => chrome.storage.local.get({ settings: {}, history: [], recess: {} });

  async function logOutcome(item, verdict, outcome, transcript = []) {
    const { history } = await getStore();
    history.unshift({ date: Date.now(), title: item.label, total: item.total, verdict, outcome, transcript });
    await chrome.storage.local.set({ history: history.slice(0, 200) });
  }

  async function recess(item) {
    const { recess } = await getStore();
    recess[item.label] = Date.now() + DAY_MS;
    await chrome.storage.local.set({ recess });
  }

  // Local checks that skip the hearing entirely.
  function shouldSkip(settings, item) {
    const never = (settings.neverSites || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (never.some((s) => location.hostname.includes(s))) return "site is on your never list";
    if (settings.skipUnder && item.total != null && item.total < Number(settings.skipUnder)) return "under your threshold";
    return null;
  }

  function profileFrom(settings) {
    const saving = settings.purpose !== "conscious";
    return {
      purpose: saving ? "saving_for_goal" : "money_conscious",
      goal:
        saving && settings.goalName
          ? { name: settings.goalName, target: Number(settings.goalAmount) || null, saved_so_far: Number(settings.savedSoFar) || null }
          : null,
      cutting_back_on: !saving ? settings.cutBack || "" : "",
      monthly_fun_budget: Number(settings.monthlyBudget) || null,
      personal_rules: settings.rules || "",
    };
  }

  // ---------- UI shell ----------

  const host = document.createElement("div");
  host.id = "gic-root";
  host.style.cssText = "all:initial; position:fixed; z-index:2147483647; inset:auto 0 0 auto;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CSS()}</style><div id="layer"></div>`;
  const layer = shadow.getElementById("layer");
  document.documentElement.appendChild(host);

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n, cur) => (n == null ? "" : `$${Number(n).toFixed(2)}${cur && cur !== "USD" ? ` ${cur}` : ""}`);

  function clearUI() {
    layer.innerHTML = "";
    host.style.inset = "auto 0 0 auto";
  }

  // Once you've chosen to go ahead, don't summon again on the next checkout step.
  const CLEARED_KEY = "gicClearedAt";
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

  // Press-and-hold button: there if you really need it, but you can't tap past it.
  function makeHoldButton(btn, onDone) {
    let timer = null;
    const start = (e) => {
      e.preventDefault();
      if (timer) return;
      btn.classList.add("holding");
      timer = setTimeout(() => {
        timer = null;
        btn.classList.remove("holding");
        onDone();
      }, SKIP_HOLD_MS);
    };
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      btn.classList.remove("holding");
    };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", cancel);
    btn.addEventListener("pointerleave", cancel);
    btn.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && !e.repeat && start(e));
    btn.addEventListener("keyup", (e) => (e.key === " " || e.key === "Enter") && cancel());
  }

  // ---------- The summons ----------

  function showSummon(item, note = "") {
    host.style.inset = "0";
    layer.innerHTML = `
      <div class="dim">
        <div class="summons" role="dialog" aria-label="You've been summoned">
          <div class="summons-badge">${GAVEL_SVG}</div>
          <div class="summons-kicker">Order in the cart!</div>
          <h2 class="summons-title">You've been summoned</h2>
          <p class="summons-sub">Judge Penny would like a quick word about</p>
          <div class="summons-item">
            <span class="summons-item-name">${esc(item.label)}</span>
            ${item.total != null ? `<span class="summons-item-price">${fmt(item.total, item.currency)}</span>` : ""}
          </div>
          ${note ? `<p class="summons-note">${esc(note)}</p>` : ""}
          <button class="btn btn-big" data-act="court">Take it to court <span class="btn-hint">about 30 sec</span></button>
          <button class="skip" data-act="skip" aria-label="Hold to skip court">
            <span class="skip-fill"></span><span class="skip-label">Hold to skip court</span>
          </button>
        </div>
      </div>`;
    layer.querySelector("[data-act=court]").onclick = () => startTrial(item);
    layer.querySelector("[data-act=court]").focus();
    const skip = layer.querySelector("[data-act=skip]");
    setTimeout(() => skip.classList.add("shown"), SKIP_REVEAL_MS);
    makeHoldButton(skip, () => {
      logOutcome(item, "none", "skipped court");
      proceedWithPurchase();
    });
  }

  // ---------- The hearing ----------
  // A little courtroom scene up top (judge on the bench, prosecutor left, you
  // right, the item as Exhibit A), with the full chat log underneath.

  const SPEAKERS = {
    judge: { name: "Judge Penny", svg: () => JUDGE_SVG },
    prosecutor: { name: "Prosecutor Pinch", svg: () => PROSECUTOR_SVG },
    defendant: { name: "You", svg: () => DEFENDANT_SVG },
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const readTime = (text) => Math.min(2600, 700 + text.length * 22); // pause so people can read each line

  async function startTrial(item) {
    const { settings } = await getStore();
    const profile = profileFrom(settings);
    const transcript = [];
    let defenses = 0;

    host.style.inset = "0";
    layer.innerHTML = `
      <div class="dim">
        <div class="court" role="dialog" aria-label="Hearing">
          <header class="court-head">
            <div class="court-title">
              <span class="court-kicker">Small Claims &amp; Big Carts</span>
              <span class="court-name">The People v. Your Cart</span>
            </div>
            <div class="pips" aria-label="Round"><span class="pip on"></span><span class="pip"></span></div>
            <button class="x" data-act="close" aria-label="Leave court">&times;</button>
          </header>

          <div class="scene" id="scene">
            <div class="wall"><div class="seal">${GAVEL_SVG}</div></div>
            <div class="spot bench" data-who="judge">
              <div class="char">${JUDGE_SVG}</div>
              <div class="desk desk-bench"><span>Judge Penny</span></div>
            </div>
            <div class="spot left" data-who="prosecutor">
              <div class="char">${PROSECUTOR_SVG}</div>
              <div class="desk"><span>Prosecution</span></div>
            </div>
            <div class="spot right" data-who="defendant">
              <div class="char">${DEFENDANT_SVG}</div>
              <div class="desk"><span>Defense (you)</span></div>
            </div>
            <div class="exhibit">
              <span class="exhibit-tag">Exhibit A</span>
              <span class="exhibit-title">${esc(item.label)}</span>
              <span class="exhibit-price">${fmt(item.total, item.currency)}</span>
              ${budgetLine(item, profile)}
            </div>
            <div class="speech" id="speech" hidden></div>
          </div>

          <div class="log" id="log" aria-live="polite"></div>
          <div class="dock" id="dock"></div>
        </div>
      </div>`;
    layer.querySelector("[data-act=close]").onclick = () => {
      logOutcome(item, "none", "left court", transcript);
      clearUI();
    };
    const scene = shadow.getElementById("scene");
    const speech = shadow.getElementById("speech");
    const logEl = shadow.getElementById("log");
    const dock = shadow.getElementById("dock");
    const pips = [...shadow.querySelectorAll(".pip")];

    function spotlight(who, text) {
      for (const s of scene.querySelectorAll(".spot")) s.classList.toggle("talking", s.dataset.who === who);
      speech.hidden = false;
      speech.className = `speech at-${who}`;
      speech.innerHTML = `<b>${esc(SPEAKERS[who].name)}</b>${esc(text)}`;
      // restart the pop animation
      speech.style.animation = "none";
      void speech.offsetWidth;
      speech.style.animation = "";
    }

    function addToLog(who, text) {
      const row = document.createElement("div");
      row.className = `msg ${who}`;
      row.innerHTML = `<div class="avatar">${SPEAKERS[who].svg()}</div>
        <div class="msg-body"><div class="who">${esc(SPEAKERS[who].name)}</div><div class="bubble">${esc(text)}</div></div>`;
      logEl.appendChild(row);
      logEl.scrollTop = logEl.scrollHeight;
    }

    async function play(lines) {
      for (const { speaker, text } of lines) {
        const who = SPEAKERS[speaker] ? speaker : "judge";
        transcript.push({ role: who, text });
        spotlight(who, text);
        addToLog(who, text);
        await wait(readTime(text));
      }
    }

    const deliberating = (who = "prosecutor") => {
      for (const s of scene.querySelectorAll(".spot")) s.classList.toggle("thinking", s.dataset.who === who);
      dock.innerHTML = `<div class="typing"><span></span><span></span><span></span> The court is conferring…</div>`;
    };
    const stopThinking = () => scene.querySelectorAll(".spot").forEach((s) => s.classList.remove("thinking"));

    async function ask(stage) {
      deliberating();
      try {
        if (settings.mode !== "live") {
          await wait(800);
          return globalThis.gicScriptedTurn({ stage, item, profile, transcript });
        }
        const res = await chrome.runtime.sendMessage({ type: "judge", stage, item, profile, transcript });
        if (res?.ok) return res.turn;
        dock.innerHTML = `<div class="error">${esc(res?.error || "Something went wrong.")}</div>
          <div class="row"><button class="btn btn-ghost" data-act="settings">Settings</button><button class="btn btn-ghost" data-act="buy">Just buy it</button></div>`;
        dock.querySelector("[data-act=settings]").onclick = () => chrome.runtime.sendMessage({ type: "openOptions" });
        dock.querySelector("[data-act=buy]").onclick = proceedWithPurchase;
        return null;
      } finally {
        stopThinking();
      }
    }

    function showDefenseInput() {
      pips.forEach((p, i) => p.classList.toggle("on", i <= defenses));
      const last = defenses === MAX_DEFENSES - 1;
      dock.innerHTML = `
        <div class="defense">
          <textarea id="defense" rows="2" placeholder="${last ? "Closing argument. Make it count." : "Your defense. Put every reason up front."}"></textarea>
          <button class="btn send" data-act="submit">${last ? "Rest my case" : "Object!"}</button>
        </div>
        <div class="row quiet">
          <button class="link" data-act="plead">Plead guilty &amp; buy</button>
          <span class="dot">·</span>
          <button class="link" data-act="recess">Recess until tomorrow</button>
        </div>`;
      const box = shadow.getElementById("defense");
      box.focus();
      dock.querySelector("[data-act=submit]").onclick = () => submit(box.value.trim());
      box.onkeydown = (e) => {
        e.stopPropagation(); // keep Amazon's keyboard shortcuts out of it
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit(box.value.trim());
        }
      };
      dock.querySelector("[data-act=plead]").onclick = () => {
        logOutcome(item, "none", "pleaded guilty", transcript);
        proceedWithPurchase();
      };
      dock.querySelector("[data-act=recess]").onclick = async () => {
        await recess(item);
        logOutcome(item, "none", "recessed", transcript);
        clearUI();
      };
    }

    async function submit(defense) {
      if (!defense) return;
      dock.innerHTML = "";
      await play([{ speaker: "defendant", text: defense }]);
      defenses += 1;
      const stage = defenses >= MAX_DEFENSES ? "verdict" : "rebut";
      const turn = await ask(stage);
      if (!turn) return;
      await play(turn.lines);
      if (stage === "verdict") showVerdict(turn);
      else showDefenseInput();
    }

    function showVerdict(turn) {
      const label = globalThis.gicVerdictTitles?.[turn.verdict] || "Verdict";
      scene.classList.add("ruled");
      dock.innerHTML = `
        <div class="verdict v-${esc(turn.verdict)}">
          <div class="stamp">${esc(label)}</div>
          ${turn.suggestion ? `<div class="verdict-tip">${esc(turn.suggestion)}</div>` : ""}
        </div>
        <div class="row">
          ${
            turn.verdict === "buy"
              ? `<button class="btn" data-act="buy">Buy it</button>`
              : `<button class="btn" data-act="follow">Take the judge's advice</button>
                 <button class="btn btn-ghost" data-act="buy">Buy anyway</button>`
          }
        </div>
        <div class="fine">Judge Penny's ruling is advice, not law. It's always your call.</div>`;
      dock.querySelector("[data-act=follow]")?.addEventListener("click", () => {
        logOutcome(item, turn.verdict, "kept", transcript);
        clearUI();
      });
      dock.querySelector("[data-act=buy]").onclick = () => {
        logOutcome(item, turn.verdict, "bought", transcript);
        proceedWithPurchase();
      };
    }

    // Opening statements
    const opening = await ask("open");
    if (!opening) return;
    await play(opening.lines);
    if (opening.skip_trial) {
      scene.classList.add("ruled");
      dock.innerHTML = `<div class="verdict v-buy"><div class="stamp">Case dismissed</div></div>
        <div class="row" style="justify-content:center"><button class="btn" data-act="buy">Carry on</button></div>`;
      dock.querySelector("[data-act=buy]").onclick = () => {
        logOutcome(item, "buy", "necessity", transcript);
        proceedWithPurchase();
      };
      return;
    }
    showDefenseInput();
  }

  function budgetLine(item, profile) {
    if (item.total == null || !profile.monthly_fun_budget) return "";
    const pct = Math.round((item.total / profile.monthly_fun_budget) * 100);
    return `<span class="exhibit-meta">${pct}% of your monthly fun budget</span>`;
  }

  // ---------- triggers ----------

  async function maybeSummon(note) {
    if (isCleared()) {
      log("Already went through court in the last 20 minutes. Letting it through.");
      return false;
    }
    const { settings, recess } = await getStore();
    if (!settings.onboarded) log("Settings never saved. Summoning anyway with an empty profile.");
    const item = scrapeItem();
    if (!item) {
      log("No item found on this page.", { page: pageType(), path: location.pathname });
      return false;
    }
    const skip = shouldSkip(settings, item);
    if (skip) {
      log(`Skipping: ${skip}.`, { total: item.total, skipUnder: settings.skipUnder, neverSites: settings.neverSites });
      return false;
    }
    log("Summoning for", item);
    const until = recess[item.label];
    const recessNote = until && until > Date.now() ? "You called a recess on this one. Ready to talk?" : "";
    showSummon(item, recessNote || note);
    return true;
  }

  // Intercept "buy" clicks (capture phase, before Amazon's handlers).
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
      e.preventDefault();
      e.stopImmediatePropagation();
      pendingButton = btn;
      const shown = await maybeSummon("Caught you mid-checkout.");
      if (!shown) proceedWithPurchase(); // nothing to judge, let it through
    },
    true
  );

  // On cart and checkout pages, summon without waiting for a click.
  log("Loaded on", pageType() || "an untracked page", location.pathname);
  if (pageType() === "cart") {
    setTimeout(() => maybeSummon(), 1200);
  }

  // ---------- art ----------

  const GAVEL_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="rotate(-35 32 32)"><rect x="14" y="14" width="28" height="14" rx="4" fill="#F5B83D" stroke="#1E1B3A" stroke-width="3"/><rect x="10" y="12" width="6" height="18" rx="2" fill="#FF6B5A" stroke="#1E1B3A" stroke-width="3"/><rect x="40" y="12" width="6" height="18" rx="2" fill="#FF6B5A" stroke="#1E1B3A" stroke-width="3"/><rect x="25" y="28" width="6" height="26" rx="3" fill="#8B5E3C" stroke="#1E1B3A" stroke-width="3"/></g><rect x="8" y="52" width="30" height="6" rx="3" fill="#1E1B3A"/></svg>`;

  const JUDGE_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="#FFE3B3"/><g fill="#fff" stroke="#1E1B3A" stroke-width="2"><circle cx="16" cy="26" r="7"/><circle cx="14" cy="38" r="7"/><circle cx="48" cy="26" r="7"/><circle cx="50" cy="38" r="7"/><path d="M14 22 Q32 2 50 22 Q32 14 14 22Z"/></g><circle cx="32" cy="32" r="13" fill="#F2C9A0" stroke="#1E1B3A" stroke-width="2"/><circle cx="27" cy="31" r="1.8" fill="#1E1B3A"/><circle cx="37" cy="31" r="1.8" fill="#1E1B3A"/><path d="M27 37 Q32 41 37 37" fill="none" stroke="#1E1B3A" stroke-width="2" stroke-linecap="round"/><path d="M22 27 l8 -1 M34 26 l8 1" stroke="#1E1B3A" stroke-width="2" stroke-linecap="round"/><path d="M20 64 Q32 46 44 64Z" fill="#1E1B3A"/></svg>`;

  const PROSECUTOR_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" fill="#FFD9D3"/><path d="M12 64 Q32 40 52 64Z" fill="#2B2D42"/><path d="M28 50 L32 64 L36 50 L32 46Z" fill="#FF6B5A"/><path d="M26 46 L32 52 L38 46" fill="#fff"/><circle cx="32" cy="30" r="14" fill="#E8B48A" stroke="#1E1B3A" stroke-width="2"/><path d="M17 26 Q20 12 34 13 Q46 14 47 26 Q40 19 30 21 Q22 22 17 26Z" fill="#1E1B3A"/><circle cx="26" cy="30" r="4.5" fill="#fff" stroke="#1E1B3A" stroke-width="2"/><circle cx="38" cy="30" r="4.5" fill="#fff" stroke="#1E1B3A" stroke-width="2"/><path d="M30.5 30 h3" stroke="#1E1B3A" stroke-width="2"/><circle cx="26" cy="30" r="1.6" fill="#1E1B3A"/><circle cx="38" cy="30" r="1.6" fill="#1E1B3A"/><path d="M21 23 l7 2 M43 23 l-7 2" stroke="#1E1B3A" stroke-width="2.2" stroke-linecap="round"/><path d="M27 38 Q32 35 37 38" fill="none" stroke="#1E1B3A" stroke-width="2" stroke-linecap="round"/></svg>`;

  const DEFENDANT_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" fill="#DDE3FF"/><path d="M12 64 Q32 40 52 64Z" fill="#5B6CFF"/><circle cx="32" cy="30" r="14" fill="#F2C9A0" stroke="#1E1B3A" stroke-width="2"/><path d="M18 28 Q18 13 32 13 Q46 13 46 28 Q42 20 32 21 Q24 21 18 28Z" fill="#6B4A2E"/><circle cx="27" cy="31" r="1.8" fill="#1E1B3A"/><circle cx="37" cy="31" r="1.8" fill="#1E1B3A"/><path d="M27 37 Q32 40 37 36" fill="none" stroke="#1E1B3A" stroke-width="2" stroke-linecap="round"/><path d="M44 22 q4 3 2 7" fill="none" stroke="#8EC5FF" stroke-width="2.4" stroke-linecap="round"/></svg>`;

  // ---------- styles ----------

  function CSS() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; }
      .dim, .dim * { font-family: ui-rounded, "SF Pro Rounded", -apple-system, "Segoe UI", system-ui, sans-serif; }
      button { font: inherit; cursor: pointer; border: none; background: none; color: inherit; }
      svg { display: block; width: 100%; height: 100%; }

      .dim { position: fixed; inset: 0; background: rgba(30, 27, 58, .55); backdrop-filter: blur(3px);
        display: grid; place-items: center; padding: 16px; animation: fade .2s ease-out; }

      .btn { background: #1E1B3A; color: #FFFBF3; font-weight: 800; padding: 11px 18px; border-radius: 999px;
        box-shadow: 0 4px 0 #000; transition: transform .08s, box-shadow .08s; }
      .btn:hover { transform: translateY(-1px); box-shadow: 0 5px 0 #000; }
      .btn:active { transform: translateY(3px); box-shadow: 0 1px 0 #000; }
      .btn-ghost { background: #FFFBF3; color: #1E1B3A; border: 2px solid #1E1B3A; box-shadow: 0 4px 0 #1E1B3A; }
      .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
      .link { color: #6B6785; font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
      .link:hover { color: #1E1B3A; }
      .quiet { justify-content: center; margin-top: 10px; }
      .dot { color: #B8B4CC; }

      /* summons */
      .summons { position: relative; width: min(420px, 100%); background: #FFFBF3; color: #1E1B3A; text-align: center;
        border: 3px solid #1E1B3A; border-radius: 24px; padding: 54px 28px 20px; box-shadow: 0 10px 0 #1E1B3A, 0 30px 80px rgba(0,0,0,.35);
        animation: pop .45s cubic-bezier(.2, 1.6, .4, 1); }
      .summons-badge { position: absolute; top: -44px; left: 50%; width: 88px; height: 88px; margin-left: -44px; padding: 14px;
        background: #F5B83D; border: 3px solid #1E1B3A; border-radius: 50%; box-shadow: 0 6px 0 #1E1B3A; }
      .summons-badge svg { animation: bang 1.6s ease-in-out .5s infinite; transform-origin: 30% 80%; }
      .summons-kicker { font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #FF6B5A; }
      .summons-title { font-family: Georgia, "Times New Roman", serif; font-size: 30px; line-height: 1.1; margin-top: 4px; }
      .summons-sub { color: #6B6785; margin-top: 8px; font-size: 14px; }
      .summons-item { margin: 12px 0 4px; padding: 12px 14px; background: #fff; border: 2px dashed #1E1B3A; border-radius: 14px;
        display: flex; gap: 10px; align-items: center; justify-content: space-between; text-align: left; }
      .summons-item-name { font-weight: 700; font-size: 14px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .summons-item-price { font-weight: 900; font-size: 18px; white-space: nowrap; }
      .summons-note { color: #B4462E; font-size: 13px; margin-top: 6px; }
      .btn-big { display: block; width: 100%; margin-top: 16px; padding: 16px; font-size: 18px; background: #FF6B5A; color: #1E1B3A;
        border: 3px solid #1E1B3A; box-shadow: 0 6px 0 #1E1B3A; animation: nudge 2.4s ease-in-out 1.2s infinite; }
      .btn-big:hover { box-shadow: 0 7px 0 #1E1B3A; }
      .btn-big:active { box-shadow: 0 2px 0 #1E1B3A; }
      .btn-hint { display: block; font-size: 11px; font-weight: 700; opacity: .7; margin-top: 2px; }
      .skip { position: relative; overflow: hidden; margin-top: 14px; padding: 6px 14px; border-radius: 999px; font-size: 12px;
        color: #8E8AA6; opacity: 0; pointer-events: none; transition: opacity .6s; user-select: none; -webkit-user-select: none; touch-action: none; }
      .skip.shown { opacity: 1; pointer-events: auto; }
      .skip-fill { position: absolute; inset: 0; background: #E9E5F5; transform: scaleX(0); transform-origin: left; border-radius: 999px; }
      .skip.holding .skip-fill { transform: scaleX(1); transition: transform ${SKIP_HOLD_MS}ms linear; }
      .skip-label { position: relative; }

      /* hearing */
      .court { width: min(720px, 100%); max-height: 94vh; display: flex; flex-direction: column; overflow: hidden;
        background: #FFFBF3; color: #1E1B3A; border: 3px solid #1E1B3A; border-radius: 24px;
        box-shadow: 0 10px 0 #1E1B3A, 0 30px 80px rgba(0,0,0,.35); animation: pop .4s cubic-bezier(.2, 1.4, .4, 1); }
      .court-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: #1E1B3A; color: #FFFBF3; }
      .court-title { flex: 1; display: flex; flex-direction: column; }
      .court-kicker { font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color: #F5B83D; }
      .court-name { font-family: Georgia, serif; font-size: 19px; font-weight: 700; }
      .pips { display: flex; gap: 6px; }
      .pip { width: 10px; height: 10px; border-radius: 50%; border: 2px solid #F5B83D; }
      .pip.on { background: #F5B83D; }
      .x { font-size: 26px; line-height: 1; opacity: .7; padding: 0 4px; color: #FFFBF3; }
      .x:hover { opacity: 1; }

      /* the scene */
      .scene { position: relative; height: 250px; flex: none; overflow: hidden; border-bottom: 3px solid #1E1B3A;
        background: linear-gradient(#F3E3C3 0 58%, #C98F5B 58% 61%, #E8B98A 61% 100%); }
      .scene::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 39%;
        background: repeating-linear-gradient(90deg, transparent 0 46px, rgba(120,70,30,.12) 46px 48px); pointer-events: none; }
      .wall { position: absolute; inset: 0 0 42% 0; background: repeating-linear-gradient(90deg, #F3E3C3 0 70px, #EDD9B3 70px 74px); }
      .seal { position: absolute; top: 10px; left: 50%; width: 46px; height: 46px; margin-left: -23px; padding: 7px; border-radius: 50%;
        background: #F5B83D; border: 3px solid #1E1B3A; opacity: .9; }
      .spot { position: absolute; display: flex; flex-direction: column; align-items: center; z-index: 1; transition: filter .2s; }
      .char { width: 74px; height: 74px; border-radius: 50%; border: 3px solid #1E1B3A; overflow: hidden; background: #FFE3B3;
        box-shadow: 0 4px 0 #1E1B3A; transition: transform .2s; }
      .desk { margin-top: -10px; padding: 14px 14px 8px; min-width: 120px; text-align: center; border: 3px solid #1E1B3A; border-radius: 10px 10px 4px 4px;
        background: #8B5E3C; color: #FFFBF3; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      .desk span { display: inline-block; padding: 2px 8px; background: #F5B83D; color: #1E1B3A; border-radius: 4px; }
      .bench { left: 50%; top: 56px; transform: translateX(-50%); }
      .bench .char { width: 66px; height: 66px; }
      .desk-bench { min-width: 190px; background: #6E4528; }
      .left { left: 4%; bottom: 14px; }
      .right { right: 4%; bottom: 14px; }
      .right .char { background: #DDE3FF; }
      .left .char { background: #FFD9D3; }
      .spot.talking .char { animation: talk .5s ease-in-out infinite alternate; box-shadow: 0 4px 0 #1E1B3A, 0 0 0 6px rgba(245,184,61,.7); }
      .spot.thinking .char { animation: think 1.2s ease-in-out infinite; }
      .scene .spot:not(.talking) { filter: saturate(.75); }
      .exhibit { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%) rotate(-2deg); z-index: 1;
        width: min(230px, 34%); padding: 8px 10px; background: #fff; border: 2px solid #1E1B3A; border-radius: 8px; box-shadow: 3px 3px 0 #1E1B3A;
        display: flex; flex-direction: column; gap: 2px; }
      .exhibit-tag { align-self: flex-start; font-size: 10px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase;
        background: #1E1B3A; color: #F5B83D; padding: 2px 6px; border-radius: 4px; }
      .exhibit-title { font-weight: 700; font-size: 12px; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .exhibit-price { font-weight: 900; font-size: 16px; }
      .exhibit-meta { font-size: 11px; color: #6B6785; }

      .speech { position: absolute; z-index: 3; max-width: 300px; padding: 10px 12px; font-size: 14px; line-height: 1.35;
        background: #fff; border: 3px solid #1E1B3A; border-radius: 14px; box-shadow: 4px 4px 0 #1E1B3A; animation: bubble .25s cubic-bezier(.2,1.6,.4,1); }
      .speech b { display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #FF6B5A; margin-bottom: 2px; }
      .speech::after { content: ""; position: absolute; width: 14px; height: 14px; background: #fff; border: 3px solid #1E1B3A;
        border-top: none; border-left: none; transform: rotate(45deg); }
      .speech.at-judge { top: 10px; left: calc(50% + 70px); }
      .speech.at-judge::after { left: -9px; top: 22px; transform: rotate(135deg); }
      .speech.at-prosecutor { bottom: 110px; left: 3%; }
      .speech.at-prosecutor::after { left: 30px; bottom: -9px; }
      .speech.at-defendant { bottom: 110px; right: 3%; background: #1E1B3A; color: #FFFBF3; }
      .speech.at-defendant b { color: #F5B83D; }
      .speech.at-defendant::after { right: 30px; bottom: -9px; background: #1E1B3A; }

      /* chat log */
      .log { flex: 1; min-height: 110px; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: #FFFBF3; }
      .msg { display: flex; gap: 8px; align-items: flex-start; animation: rise .3s ease-out; }
      .msg.defendant { flex-direction: row-reverse; }
      .msg .avatar { width: 30px; height: 30px; flex: none; border-radius: 50%; border: 2px solid #1E1B3A; overflow: hidden; background: #FFE3B3; }
      .msg.prosecutor .avatar { background: #FFD9D3; }
      .msg.defendant .avatar { background: #DDE3FF; }
      .msg-body { max-width: 78%; display: flex; flex-direction: column; }
      .msg.defendant .msg-body { align-items: flex-end; }
      .who { font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #6B6785; margin: 0 4px 2px; }
      .bubble { padding: 9px 12px; border-radius: 14px; font-size: 14px; line-height: 1.4; border: 2px solid #1E1B3A; background: #fff; }
      .judge .bubble { box-shadow: 3px 3px 0 #F5B83D; border-top-left-radius: 4px; }
      .prosecutor .bubble { box-shadow: 3px 3px 0 #FF6B5A; border-top-left-radius: 4px; }
      .defendant .bubble { background: #1E1B3A; color: #FFFBF3; border-top-right-radius: 4px; }

      .dock { padding: 12px 16px 14px; border-top: 2px dashed #D9D4EA; min-height: 58px; }
      .defense { display: flex; gap: 8px; align-items: flex-end; }
      textarea { flex: 1; font: inherit; font-size: 15px; padding: 11px 14px; border: 2px solid #1E1B3A; border-radius: 16px;
        background: #fff; color: #1E1B3A; resize: none; outline: none; }
      textarea:focus { box-shadow: 0 0 0 4px rgba(245, 184, 61, .45); }
      .send { background: #F5B83D; color: #1E1B3A; border: 2px solid #1E1B3A; box-shadow: 0 4px 0 #1E1B3A; white-space: nowrap; }
      .typing { display: flex; align-items: center; gap: 4px; color: #6B6785; font-size: 14px; font-style: italic; }
      .typing span { width: 7px; height: 7px; border-radius: 50%; background: #F5B83D; animation: blink 1s infinite; }
      .typing span:nth-child(2) { animation-delay: .15s; } .typing span:nth-child(3) { animation-delay: .3s; margin-right: 6px; }
      .error { color: #B4462E; }

      .verdict { text-align: center; padding: 4px 0 0; }
      .stamp { display: inline-block; font-family: Georgia, serif; font-weight: 900; font-size: 24px; text-transform: uppercase; letter-spacing: .04em;
        padding: 6px 18px; border: 4px solid currentColor; border-radius: 10px; transform: rotate(-4deg);
        animation: stamp .35s cubic-bezier(.2, 1.8, .4, 1); }
      .v-buy .stamp { color: #1F9D6B; } .v-wait .stamp { color: #D98A0B; } .v-skip .stamp { color: #E0533F; }
      .verdict-tip { margin-top: 10px; font-size: 14px; background: #fff; border: 2px solid #1E1B3A; border-radius: 14px; padding: 10px 12px; }
      .verdict + .row { justify-content: center; }
      .fine { margin-top: 10px; font-size: 12px; color: #8E8AA6; text-align: center; }

      @media (max-width: 560px) {
        .scene { height: 220px; }
        .char { width: 54px; height: 54px; } .bench .char { width: 50px; height: 50px; }
        .desk { min-width: 90px; font-size: 9px; } .desk-bench { min-width: 130px; }
        .exhibit { display: none; }
        .speech { max-width: 70%; font-size: 13px; }
        .speech.at-judge { left: auto; right: 3%; }
      }

      @keyframes fade { from { opacity: 0; } }
      @keyframes pop { from { transform: scale(.85) translateY(20px); opacity: 0; } }
      @keyframes rise { from { transform: translateY(8px); opacity: 0; } }
      @keyframes stamp { from { transform: rotate(-4deg) scale(2.2); opacity: 0; } }
      @keyframes talk { from { transform: translateY(0) rotate(-2deg); } to { transform: translateY(-5px) rotate(2deg); } }
      @keyframes think { 0%, 100% { transform: none; } 50% { transform: translateY(-3px); } }
      @keyframes bubble { from { transform: scale(.6); opacity: 0; } }
      @keyframes blink { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
      @keyframes bang { 0%, 70%, 100% { transform: rotate(0); } 78% { transform: rotate(-22deg); } 86% { transform: rotate(6deg); } }
      @keyframes nudge { 0%, 85%, 100% { transform: none; } 90% { transform: rotate(-1.5deg); } 95% { transform: rotate(1.5deg); } }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
    `;
  }
})();
