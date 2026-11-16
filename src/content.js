// Content script: detects the shopping moment, shows the "Emergency Summon"
// toast, and runs the trial overlay. All UI lives in a shadow root so Amazon's
// CSS can't touch it (and ours can't break Amazon).

(() => {
  if (window.__gicLoaded) return;
  window.__gicLoaded = true;

  const MAX_DEFENSES = 2; // team decision: 1-2 rounds max
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Buttons that mean "I'm buying now". Amazon changes these, so keep a list.
  const BUY_SELECTORS = [
    "#buy-now-button",
    "input[name='proceedToRetailCheckout']",
    "[data-feature-id='proceed-to-checkout-action'] input",
    "input[name='placeYourOrder1']",
    "#submitOrderButtonId input",
    "[data-gic-buy]", // test page
  ];

  let pendingButton = null; // the buy button we intercepted
  let allowNextClick = false;

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
    const m = (s || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  };

  function pageType() {
    const p = location.pathname;
    if (/\/(gp\/buy|checkout)(\/|$)/.test(p)) return "checkout";
    if (/\/(gp\/cart|cart)(\/|$)/.test(p)) return "cart";
    if (document.querySelector("#productTitle")) return "product";
    return null;
  }

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

  function scrapeCart() {
    const seen = new Set();
    const items = [];
    for (const row of document.querySelectorAll("#sc-active-cart [data-asin], .sc-list-item[data-asin]")) {
      const asin = row.dataset.asin;
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      const title = firstText([".sc-product-title", ".a-truncate-full", "a.sc-product-link"], row);
      if (!title) continue;
      items.push({
        title,
        price: parseFloat(row.dataset.price) || money(firstText([".sc-product-price", ".a-price .a-offscreen"], row)),
        quantity: parseInt(row.dataset.quantity, 10) || 1,
      });
    }
    const sum = items.reduce((t, i) => t + (i.price || 0) * i.quantity, 0);
    const total = money(firstText(["#sc-subtotal-amount-activecart", "#sc-subtotal-amount-buybox"])) ?? sum;
    return items.length ? { items, total } : null;
  }

  function scrapeCheckout() {
    const total = money(
      firstText([".grand-total-price", "#subtotals-marketplace-table .grand-total-price", "[data-testid='order-summary-total']"])
    );
    const titles = [...document.querySelectorAll(".item-title, .lineitem-title-text")]
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    const items = titles.length ? titles.map((title) => ({ title })) : [{ title: "Your order" }];
    return total ? { items, total } : null;
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

  async function logOutcome(item, verdict, outcome) {
    const { history } = await getStore();
    history.unshift({ date: Date.now(), title: item.label, total: item.total, verdict, outcome });
    await chrome.storage.local.set({ history: history.slice(0, 200) });
  }

  async function recess(item) {
    const { recess } = await getStore();
    recess[item.label] = Date.now() + DAY_MS;
    await chrome.storage.local.set({ recess });
  }

  // Local checks that skip the trial before we ever call the API.
  function shouldSkip(settings, item) {
    const never = (settings.neverSites || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (never.some((s) => location.hostname.includes(s))) return "site is on your never list";
    if (settings.skipUnder && item.total != null && item.total < Number(settings.skipUnder)) return "under your threshold";
    return null;
  }

  function profileFrom(settings) {
    return {
      goal: settings.goalName
        ? { name: settings.goalName, target: Number(settings.goalAmount) || null, saved_so_far: Number(settings.savedSoFar) || null }
        : null,
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
  const fmt = (n) => (n == null ? "" : `$${Number(n).toFixed(2)}`);

  function clearUI() {
    layer.innerHTML = "";
    host.style.inset = "auto 0 0 auto";
  }

  function proceedWithPurchase() {
    clearUI();
    if (pendingButton) {
      allowNextClick = true;
      const btn = pendingButton;
      pendingButton = null;
      btn.click();
    }
  }

  // ---------- Emergency Summon toast ----------

  function showSummon(item, note = "") {
    host.style.inset = "auto 0 0 auto";
    layer.innerHTML = `
      <div class="toast" role="dialog" aria-label="Emergency summon">
        <div class="toast-title">Emergency summon</div>
        <div class="toast-body">${esc(item.label)}${item.total != null ? ` · <b>${fmt(item.total)}</b>` : ""}</div>
        ${note ? `<div class="toast-note">${esc(note)}</div>` : ""}
        <div class="row">
          <button class="primary" data-act="court">Take it to court</button>
          <button class="ghost" data-act="pass">Not now</button>
        </div>
      </div>`;
    layer.querySelector("[data-act=court]").onclick = () => startTrial(item);
    layer.querySelector("[data-act=pass]").onclick = () => {
      logOutcome(item, "none", "dismissed");
      proceedWithPurchase();
    };
  }

  // ---------- Trial overlay ----------

  async function startTrial(item) {
    const { settings } = await getStore();
    const profile = profileFrom(settings);
    const transcript = [];
    let defenses = 0;

    host.style.inset = "0";
    layer.innerHTML = `
      <div class="backdrop">
        <div class="court" role="dialog" aria-label="Trial">
          <header>
            <span>Court is in session</span>
            <button class="x" data-act="close" aria-label="Leave court">&times;</button>
          </header>
          <div class="exhibit">
            <div class="exhibit-label">Exhibit A</div>
            <div class="exhibit-title">${esc(item.label)}</div>
            <div class="exhibit-price">${fmt(item.total)}${budgetLine(item, profile)}</div>
          </div>
          <div class="transcript" id="transcript"></div>
          <div class="dock" id="dock"></div>
        </div>
      </div>`;
    layer.querySelector("[data-act=close]").onclick = () => {
      logOutcome(item, "none", "left court");
      clearUI();
    };
    const transcriptEl = shadow.getElementById("transcript");
    const dock = shadow.getElementById("dock");

    const say = (role, msg) => {
      transcript.push({ role, text: msg });
      const div = document.createElement("div");
      div.className = `bubble ${role}`;
      div.innerHTML = `<span class="who">${role === "judge" ? "Judge" : "You"}</span>${esc(msg)}`;
      transcriptEl.appendChild(div);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    };

    const thinking = () => {
      dock.innerHTML = `<div class="thinking">The judge is reviewing the evidence…</div>`;
    };

    async function ask(stage) {
      thinking();
      if (settings.mode !== "live") {
        await new Promise((r) => setTimeout(r, 700)); // a beat so it feels like the judge is thinking
        return globalThis.gicScriptedTurn({ stage, item, profile, transcript });
      }
      const res = await chrome.runtime.sendMessage({ type: "judge", stage, item, profile, transcript });
      if (!res?.ok) {
        dock.innerHTML = `<div class="error">${esc(res?.error || "Something went wrong.")}</div>
          <div class="row"><button class="ghost" data-act="settings">Settings</button><button class="ghost" data-act="buy">Just buy it</button></div>`;
        dock.querySelector("[data-act=settings]").onclick = () => chrome.runtime.sendMessage({ type: "openOptions" });
        dock.querySelector("[data-act=buy]").onclick = proceedWithPurchase;
        return null;
      }
      return res.turn;
    }

    function showDefenseInput() {
      const last = defenses === MAX_DEFENSES - 1;
      dock.innerHTML = `
        <textarea id="defense" rows="3" placeholder="Make your case. Put every reason up front."></textarea>
        <div class="row">
          <button class="primary" data-act="submit">${last ? "Rest my case" : "Submit defense"}</button>
          <button class="ghost" data-act="plead">Plead guilty &amp; buy</button>
          <button class="ghost" data-act="recess">Recess until tomorrow</button>
        </div>`;
      const box = shadow.getElementById("defense");
      box.focus();
      dock.querySelector("[data-act=submit]").onclick = () => submit(box.value.trim());
      box.onkeydown = (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(box.value.trim());
      };
      dock.querySelector("[data-act=plead]").onclick = () => {
        logOutcome(item, "none", "pleaded guilty");
        proceedWithPurchase();
      };
      dock.querySelector("[data-act=recess]").onclick = async () => {
        await recess(item);
        logOutcome(item, "none", "recessed");
        clearUI();
      };
    }

    async function submit(defense) {
      if (!defense) return;
      say("defendant", defense);
      defenses += 1;
      const stage = defenses >= MAX_DEFENSES ? "verdict" : "rebut";
      const turn = await ask(stage);
      if (!turn) return;
      say("judge", turn.judge_says);
      if (stage === "verdict") showVerdict(turn);
      else showDefenseInput();
    }

    function showVerdict(turn) {
      const label = globalThis.gicVerdictTitles?.[turn.verdict] || "Verdict";
      dock.innerHTML = `
        <div class="verdict v-${esc(turn.verdict)}">
          <div class="verdict-label">${label}</div>
          ${turn.suggestion ? `<div class="verdict-tip">${esc(turn.suggestion)}</div>` : ""}
          <div class="fine">The verdict is a suggestion. You can always still buy.</div>
        </div>
        <div class="row">
          ${
            turn.verdict === "buy"
              ? `<button class="primary" data-act="buy">Buy it</button>`
              : `<button class="primary" data-act="follow">Follow the verdict</button>
                 <button class="ghost" data-act="buy">Buy anyway</button>`
          }
        </div>`;
      dock.querySelector("[data-act=follow]")?.addEventListener("click", () => {
        logOutcome(item, turn.verdict, "kept");
        clearUI();
      });
      dock.querySelector("[data-act=buy]").onclick = () => {
        logOutcome(item, turn.verdict, "bought");
        proceedWithPurchase();
      };
    }

    // Opening statement
    const opening = await ask("open");
    if (!opening) return;
    say("judge", opening.judge_says);
    if (opening.skip_trial) {
      dock.innerHTML = `<div class="row"><button class="primary" data-act="buy">Carry on</button></div>`;
      dock.querySelector("[data-act=buy]").onclick = () => {
        logOutcome(item, "buy", "necessity");
        proceedWithPurchase();
      };
      return;
    }
    showDefenseInput();
  }

  function budgetLine(item, profile) {
    if (item.total == null || !profile.monthly_fun_budget) return "";
    const pct = Math.round((item.total / profile.monthly_fun_budget) * 100);
    return ` <span class="muted">· ${pct}% of your monthly fun budget</span>`;
  }

  // ---------- triggers ----------

  async function maybeSummon(note) {
    const { settings, recess } = await getStore();
    if (!settings.onboarded) return false;
    const item = scrapeItem();
    if (!item) return false;
    if (shouldSkip(settings, item)) return false;
    const until = recess[item.label];
    const recessNote = until && until > Date.now() ? "You put this in recess until tomorrow." : "";
    showSummon(item, recessNote || note);
    return true;
  }

  // Intercept "buy" clicks (capture phase, before Amazon's handlers).
  document.addEventListener(
    "click",
    async (e) => {
      const btn = e.target.closest?.(BUY_SELECTORS.join(","));
      if (!btn) return;
      if (allowNextClick) {
        allowNextClick = false;
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      pendingButton = btn;
      const shown = await maybeSummon("Hold on, you were about to buy.");
      if (!shown) proceedWithPurchase(); // nothing to judge, let it through
    },
    true
  );

  // On cart and checkout pages, summon without waiting for a click.
  if (pageType() === "cart" || pageType() === "checkout") {
    setTimeout(() => maybeSummon(), 1200);
  }

  // ---------- styles ----------

  function CSS() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-rounded, -apple-system, "Segoe UI", sans-serif; }
      button { font: inherit; cursor: pointer; border-radius: 8px; padding: 8px 12px; border: 1px solid #1f2937; }
      .primary { background: #1f2937; color: #fff; }
      .ghost { background: #fff; color: #1f2937; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .muted { color: #6b7280; font-weight: 400; }

      .toast { position: fixed; right: 20px; bottom: 20px; width: 320px; background: #fffbea; color: #1f2937;
        border: 2px solid #1f2937; border-radius: 12px; padding: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
      .toast-title { font-weight: 800; font-size: 16px; text-transform: uppercase; letter-spacing: .04em; }
      .toast-body { margin-top: 6px; font-size: 14px; }
      .toast-note { margin-top: 6px; font-size: 13px; color: #92400e; }

      .backdrop { position: fixed; inset: 0; background: rgba(17,24,39,.6); display: grid; place-items: center; padding: 16px; }
      .court { width: min(640px, 100%); max-height: 90vh; display: flex; flex-direction: column; background: #fff; color: #1f2937;
        border-radius: 14px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
      header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #1f2937; color: #fff; font-weight: 700; }
      .x { background: transparent; color: #fff; border: none; font-size: 22px; padding: 0 4px; }
      .exhibit { padding: 12px 16px; border-bottom: 1px solid #e5e7eb; background: #f9fafb; }
      .exhibit-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; }
      .exhibit-title { font-weight: 600; margin-top: 2px; }
      .exhibit-price { font-weight: 700; margin-top: 2px; }
      .transcript { padding: 12px 16px; overflow-y: auto; flex: 1; min-height: 120px; display: flex; flex-direction: column; gap: 8px; }
      .bubble { padding: 10px 12px; border-radius: 10px; max-width: 85%; font-size: 14px; line-height: 1.4; }
      .bubble .who { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 2px; opacity: .7; }
      .bubble.judge { background: #fef3c7; align-self: flex-start; }
      .bubble.defendant { background: #e0e7ff; align-self: flex-end; }
      .dock { padding: 12px 16px; border-top: 1px solid #e5e7eb; }
      textarea { width: 100%; font: inherit; font-size: 14px; padding: 8px; border-radius: 8px; border: 1px solid #d1d5db; resize: vertical; }
      .thinking { font-style: italic; color: #6b7280; }
      .error { color: #b91c1c; }
      .verdict { padding: 10px 12px; border-radius: 10px; background: #f3f4f6; }
      .verdict-label { font-weight: 800; font-size: 18px; }
      .v-buy { background: #dcfce7; } .v-wait { background: #fef9c3; } .v-skip { background: #fee2e2; }
      .verdict-tip { margin-top: 4px; }
      .fine { margin-top: 6px; font-size: 12px; color: #6b7280; }
    `;
  }
})();
