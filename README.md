# Guilty if Charged (Money Maker prototype)

Chrome extension proof of concept for the Persuasive Design project. When you're about to buy something on Amazon, an "Emergency Summon" toast appears. If you take it to court, a judge asks you to defend the purchase in up to 2 rounds, then gives a verdict. The verdict is only a suggestion and you can always still buy.

The judge has two modes, picked on the settings page:

- **Scripted (default, free):** canned lines in `src/script.js` filled in with what's on the page (item, price, cart size, time of day) and your settings (goal, budget, rules). It reacts to keywords in your defense like "broken", "sale" or "tough week".
- **Live:** a model on OpenRouter writes each turn. Needs an OpenRouter key. Default model is `anthropic/claude-haiku-5.5`.

## Run it

No build step.

1. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick this folder.
2. The settings page opens. Fill in a goal, budget and rules if you like, then save. Saving is what turns the summon on.
3. Try it:
   - Offline: `npm run test-page`, then open http://localhost:8000/cart/ or http://localhost:8000/product.html
   - Live: any amazon.com or amazon.ca product, cart or checkout page

After editing any file, click reload on the extension in `chrome://extensions`, then refresh the shopping page.

## Preview without installing

`npm run preview`, then open http://localhost:8765/test/cart/preview.html. It fakes the Chrome storage API with a sample profile so you can see the summons and hearing in any browser. Handy for the Figma folks.

## How it's built

| File | Job |
|---|---|
| `manifest.json` | MV3 manifest. Content script runs on Amazon and localhost |
| `src/content.js` | Scrapes the item, intercepts Buy Now and Proceed to Checkout, shows the toast and trial overlay (shadow DOM) |
| `src/script.js` | Scripted judge. All judge copy is in `LINES` at the top, so writers can edit it directly |
| `src/background.js` | Service worker for live mode. Calls OpenRouter with a JSON schema and returns one judge turn |
| `options.html/js` | One-time onboarding: goal, budget, rules, never-trigger sites, skip-under threshold, API key |
| `popup.html/js` | Toolbar "homepage": money kept and recent trials |
| `test/` | Mock Amazon cart and product pages using Amazon's IDs and classes |

The trial flow is `open` → defense 1 → `rebut` → defense 2 → `verdict`. The judge can skip the trial in its opening line if the item looks like a necessity. Buttons for "Plead guilty & buy", "Recess until tomorrow" and an X to leave are always there.

## Known gaps

- **API key in the browser (live mode).** OK for team testing, not for a release. Before anyone outside the team installs it, put a small proxy (e.g. a Cloudflare Worker) in front of the API.
- **Amazon selectors.** Product page selectors were checked on live amazon.com (Nov 2026). Cart rows use Amazon's `data-producttitle` / `data-price` attributes. The cart subtotal, checkout button and checkout page are still unchecked.
- **Selectors will drift.** They're kept in lists at the top of the scrape functions in `content.js`. Check them against live pages.
- **Amazon only.** Other stores need their own selectors. A generic fallback (look for buttons labelled "checkout" or "place order") is possible but less reliable.
- **Live mode JSON.** Not every OpenRouter model follows the JSON schema. The four on the settings page do.
