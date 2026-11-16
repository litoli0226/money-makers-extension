# Guilty if Charged (Money Maker prototype)

Chrome extension proof of concept for the Persuasive Design project. When you're about to buy something on Amazon, an "Emergency Summon" toast appears. If you take it to court, an AI judge (Claude) asks you to defend the purchase in up to 2 rounds, then gives a verdict. The verdict is only a suggestion and you can always still buy.

## Run it

1. `npm install && npm run build`
2. Open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick this folder.
3. The settings page opens. Add an Anthropic API key and (optionally) a goal, budget and rules. Then save.
4. Try it:
   - Offline: `npm run test-page`, then open http://localhost:8000/cart/ or http://localhost:8000/product.html
   - Live: any amazon.com or amazon.ca product, cart or checkout page

After changing `src/background.js`, run `npm run build` and click reload on the extension. Changes to `src/content.js` only need the reload.

## How it's built

| File | Job |
|---|---|
| `manifest.json` | MV3 manifest. Content script runs on Amazon and localhost |
| `src/content.js` | Scrapes the item, intercepts Buy Now and Proceed to Checkout, shows the toast and trial overlay (shadow DOM) |
| `src/background.js` | Service worker. Calls Claude (`claude-opus-5-5`, low effort, JSON-schema output) and returns one judge turn |
| `options.html/js` | One-time onboarding: goal, budget, rules, never-trigger sites, skip-under threshold, API key |
| `popup.html/js` | Toolbar "homepage": money kept and recent trials |
| `test/` | Mock Amazon cart and product pages using Amazon's IDs and classes |

The trial flow is `open` → defense 1 → `rebut` → defense 2 → `verdict`. The judge can skip the trial in its opening line if the item looks like a necessity. Buttons for "Plead guilty & buy", "Recess until tomorrow" and an X to leave are always there.

## Known gaps

- **API key in the browser.** OK for team testing, not for a release. Before anyone outside the team installs it, put a small proxy (e.g. a Cloudflare Worker) in front of the API.
- **Amazon selectors will drift.** They're kept in lists at the top of the scrape functions in `content.js`. Check them against live pages.
- **Amazon only.** Other stores need their own selectors. A generic fallback (look for buttons labelled "checkout" or "place order") is possible but less reliable.
- **Model choice.** Opus at low effort is the default. If it feels slow at checkout, try a smaller model in `MODEL`.
