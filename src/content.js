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

  // Not checked against a live page yet.
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
            ${item.total != null ? `<span class="summons-item-price">${fmt(item.total)}</span>` : ""}
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
            <div class="judge-id">
              <div class="avatar">${JUDGE_SVG}</div>
              <div>
                <div class="judge-name">Judge Penny</div>
                <div class="judge-sub">Small Claims &amp; Big Carts</div>
              </div>
            </div>
            <div class="pips" aria-label="Round"><span class="pip on"></span><span class="pip"></span></div>
            <button class="x" data-act="close" aria-label="Leave court">&times;</button>
          </header>
          <div class="exhibit">
            <span class="exhibit-tag">Exhibit A</span>
            <span class="exhibit-title">${esc(item.label)}</span>
            <span class="exhibit-price">${fmt(item.total)}</span>
            ${budgetLine(item, profile)}
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
    const pips = [...shadow.querySelectorAll(".pip")];

    const say = (role, msg) => {
      transcript.push({ role, text: msg });
      const div = document.createElement("div");
      div.className = `msg ${role}`;
      div.innerHTML =
        role === "judge"
          ? `<div class="avatar sm">${JUDGE_SVG}</div><div class="bubble">${esc(msg)}</div>`
          : `<div class="bubble">${esc(msg)}</div>`;
      transcriptEl.appendChild(div);
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    };

    const typing = () => {
      dock.innerHTML = `<div class="typing"><span></span><span></span><span></span> Judge Penny is deliberating</div>`;
    };

    async function ask(stage) {
      typing();
      if (settings.mode !== "live") {
        await new Promise((r) => setTimeout(r, 900)); // a beat so it feels like the judge is thinking
        return globalThis.gicScriptedTurn({ stage, item, profile, transcript });
      }
      const res = await chrome.runtime.sendMessage({ type: "judge", stage, item, profile, transcript });
      if (!res?.ok) {
        dock.innerHTML = `<div class="error">${esc(res?.error || "Something went wrong.")}</div>
          <div class="row"><button class="btn btn-ghost" data-act="settings">Settings</button><button class="btn btn-ghost" data-act="buy">Just buy it</button></div>`;
        dock.querySelector("[data-act=settings]").onclick = () => chrome.runtime.sendMessage({ type: "openOptions" });
        dock.querySelector("[data-act=buy]").onclick = proceedWithPurchase;
        return null;
      }
      return res.turn;
    }

    function showDefenseInput() {
      pips.forEach((p, i) => p.classList.toggle("on", i <= defenses));
      const last = defenses === MAX_DEFENSES - 1;
      dock.innerHTML = `
        <div class="defense">
          <textarea id="defense" rows="2" placeholder="Make your case, counselor. Put every reason up front."></textarea>
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
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit(box.value.trim());
        }
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
      dock.innerHTML = `<div class="row"><button class="btn" data-act="buy">Carry on</button></div>`;
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
    return `<span class="exhibit-meta">${pct}% of your monthly fun budget</span>`;
  }

  // ---------- triggers ----------

  async function maybeSummon(note) {
    const { settings, recess } = await getStore();
    if (!settings.onboarded) return false;
    const item = scrapeItem();
    if (!item) return false;
    if (shouldSkip(settings, item)) return false;
    const until = recess[item.label];
    const recessNote = until && until > Date.now() ? "You called a recess on this one. Ready to talk?" : "";
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
      const shown = await maybeSummon("Caught you mid-checkout.");
      if (!shown) proceedWithPurchase(); // nothing to judge, let it through
    },
    true
  );

  // On cart and checkout pages, summon without waiting for a click.
  if (pageType() === "cart" || pageType() === "checkout") {
    setTimeout(() => maybeSummon(), 1200);
  }

  // ---------- art ----------

  const GAVEL_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="rotate(-35 32 32)"><rect x="14" y="14" width="28" height="14" rx="4" fill="#F5B83D" stroke="#1E1B3A" stroke-width="3"/><rect x="10" y="12" width="6" height="18" rx="2" fill="#FF6B5A" stroke="#1E1B3A" stroke-width="3"/><rect x="40" y="12" width="6" height="18" rx="2" fill="#FF6B5A" stroke="#1E1B3A" stroke-width="3"/><rect x="25" y="28" width="6" height="26" rx="3" fill="#8B5E3C" stroke="#1E1B3A" stroke-width="3"/></g><rect x="8" y="52" width="30" height="6" rx="3" fill="#1E1B3A"/></svg>`;

  const JUDGE_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="#FFE3B3"/><g fill="#fff" stroke="#1E1B3A" stroke-width="2"><circle cx="16" cy="26" r="7"/><circle cx="14" cy="38" r="7"/><circle cx="48" cy="26" r="7"/><circle cx="50" cy="38" r="7"/><path d="M14 22 Q32 2 50 22 Q32 14 14 22Z"/></g><circle cx="32" cy="32" r="13" fill="#F2C9A0" stroke="#1E1B3A" stroke-width="2"/><circle cx="27" cy="31" r="1.8" fill="#1E1B3A"/><circle cx="37" cy="31" r="1.8" fill="#1E1B3A"/><path d="M27 37 Q32 41 37 37" fill="none" stroke="#1E1B3A" stroke-width="2" stroke-linecap="round"/><path d="M22 27 l8 -1 M34 26 l8 1" stroke="#1E1B3A" stroke-width="2" stroke-linecap="round"/><path d="M20 64 Q32 46 44 64Z" fill="#1E1B3A"/></svg>`;

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
      .court { width: min(600px, 100%); max-height: min(720px, 92vh); display: flex; flex-direction: column; overflow: hidden;
        background: #FFFBF3; color: #1E1B3A; border: 3px solid #1E1B3A; border-radius: 24px;
        box-shadow: 0 10px 0 #1E1B3A, 0 30px 80px rgba(0,0,0,.35); animation: pop .4s cubic-bezier(.2, 1.4, .4, 1); }
      .court-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: #1E1B3A; color: #FFFBF3; }
      .judge-id { display: flex; align-items: center; gap: 10px; flex: 1; }
      .avatar { width: 46px; height: 46px; border-radius: 50%; border: 2px solid #F5B83D; overflow: hidden; flex: none; background: #FFE3B3; }
      .avatar.sm { width: 34px; height: 34px; border-color: #1E1B3A; }
      .judge-name { font-family: Georgia, serif; font-size: 18px; font-weight: 700; }
      .judge-sub { font-size: 12px; opacity: .7; }
      .pips { display: flex; gap: 6px; }
      .pip { width: 10px; height: 10px; border-radius: 50%; border: 2px solid #F5B83D; }
      .pip.on { background: #F5B83D; }
      .x { font-size: 26px; line-height: 1; opacity: .7; padding: 0 4px; color: #FFFBF3; }
      .x:hover { opacity: 1; }

      .exhibit { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 12px 16px;
        background: repeating-linear-gradient(-45deg, #FFF3D6, #FFF3D6 10px, #FFEFC9 10px, #FFEFC9 20px); border-bottom: 2px solid #1E1B3A; }
      .exhibit-tag { font-size: 11px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; background: #1E1B3A; color: #F5B83D;
        padding: 3px 8px; border-radius: 6px; }
      .exhibit-title { font-weight: 700; flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .exhibit-price { font-weight: 900; font-size: 18px; }
      .exhibit-meta { width: 100%; font-size: 12px; color: #6B6785; }

      .transcript { flex: 1; min-height: 140px; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      .msg { display: flex; gap: 8px; align-items: flex-end; animation: rise .3s ease-out; }
      .msg.defendant { justify-content: flex-end; }
      .bubble { max-width: 80%; padding: 11px 14px; border-radius: 18px; font-size: 15px; line-height: 1.45; border: 2px solid #1E1B3A; }
      .judge .bubble { background: #fff; border-bottom-left-radius: 6px; box-shadow: 3px 3px 0 #F5B83D; }
      .defendant .bubble { background: #1E1B3A; color: #FFFBF3; border-bottom-right-radius: 6px; }

      .dock { padding: 14px 16px 16px; border-top: 2px dashed #D9D4EA; }
      .defense { display: flex; gap: 8px; align-items: flex-end; }
      textarea { flex: 1; font: inherit; font-size: 15px; padding: 11px 14px; border: 2px solid #1E1B3A; border-radius: 16px;
        background: #fff; color: #1E1B3A; resize: none; outline: none; }
      textarea:focus { box-shadow: 0 0 0 4px rgba(245, 184, 61, .45); }
      .send { background: #F5B83D; color: #1E1B3A; border: 2px solid #1E1B3A; box-shadow: 0 4px 0 #1E1B3A; white-space: nowrap; }
      .typing { display: flex; align-items: center; gap: 4px; color: #6B6785; font-size: 14px; font-style: italic; }
      .typing span { width: 7px; height: 7px; border-radius: 50%; background: #F5B83D; animation: blink 1s infinite; }
      .typing span:nth-child(2) { animation-delay: .15s; } .typing span:nth-child(3) { animation-delay: .3s; margin-right: 6px; }
      .error { color: #B4462E; }

      .verdict { text-align: center; padding: 6px 0 2px; }
      .stamp { display: inline-block; font-family: Georgia, serif; font-weight: 900; font-size: 24px; text-transform: uppercase; letter-spacing: .04em;
        padding: 8px 18px; border: 4px solid currentColor; border-radius: 10px; transform: rotate(-4deg);
        animation: stamp .35s cubic-bezier(.2, 1.8, .4, 1); }
      .v-buy .stamp { color: #1F9D6B; } .v-wait .stamp { color: #D98A0B; } .v-skip .stamp { color: #E0533F; }
      .verdict-tip { margin-top: 12px; font-size: 14px; background: #fff; border: 2px solid #1E1B3A; border-radius: 14px; padding: 10px 12px; }
      .verdict + .row { justify-content: center; }
      .fine { margin-top: 10px; font-size: 12px; color: #8E8AA6; text-align: center; }

      @keyframes fade { from { opacity: 0; } }
      @keyframes pop { from { transform: scale(.85) translateY(20px); opacity: 0; } }
      @keyframes rise { from { transform: translateY(8px); opacity: 0; } }
      @keyframes stamp { from { transform: rotate(-4deg) scale(2.2); opacity: 0; } }
      @keyframes blink { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
      @keyframes bang { 0%, 70%, 100% { transform: rotate(0); } 78% { transform: rotate(-22deg); } 86% { transform: rotate(6deg); } }
      @keyframes nudge { 0%, 85%, 100% { transform: none; } 90% { transform: rotate(-1.5deg); } 95% { transform: rotate(1.5deg); } }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
    `;
  }
})();
