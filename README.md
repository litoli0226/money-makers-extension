# Money Makers

Chrome extension prototype for our Persuasive Design project. Right before you check out on Amazon, a **quick check** asks if you really need it. Save it, buy it, or say "Yes, I want it" and make your case to **the judge** in a short courtroom chat. The verdict is advice. You always decide.

Screens follow the team's Figma file (Low-Mid-Fi Wireframes Iteration 2, "Hi-fi prototype"): quick check, saved pop-up, courtroom rounds, deliberating, verdicts, totally okay, home window and settings.

## Try it (5 minutes)

1. Download this repo: **Code → Download ZIP** and unzip it, or `git clone` it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick the unzipped folder.
3. The settings page opens. Add a savings goal if you want (or leave it blank).
4. Go to amazon.com or amazon.ca, add something to your cart and open the cart, or click **Buy Now** on a product.

After pulling new changes, click the reload icon on the extension in `chrome://extensions`, then refresh the Amazon tab.

Nothing gets bought by the extension. It only pauses the checkout button and clicks it again if you choose to go ahead.

## How a trial works

The rules are in `src/flow.js`, so key moments always happen for the same reason, whether the lines come from the script or from AI.

| Moment | When it happens |
|---|---|
| **Rounds** | 4 questions by default. |
| **Ends early** | Two low-effort answers ("idk", one word), or the case is clearly decided (score +4 or -4 after 2 answers). |
| **Expert witness** | Once, after answer 2, only if the case is too close to call (score -1 to +1). Price arguments call the price analyst, need or usage arguments call the cost-per-use analyst, anything else calls "future you". |
| **Extra round** | After the last round, if the case is leaning yes (+1) but not convincing yet. Up to 6 rounds. |
| **Verdict** | +2 or more: case approved. -1 or less: save it for later. 0 or +1: recess, meaning a reasonable case that didn't clear the bar, so sleep on it. |

Each answer is scored strong (+2), good (+1), neutral (0), weak (-1) or impulse (-2). In scripted mode the score comes from keywords in `src/script.js`. In AI mode the judge model scores it using the rubric in `src/background.js`, but it never decides what happens next.

## Who runs the court

Pick in **Settings → Court settings**.

- **Scripted (default, free).** Canned lines in `src/script.js`, filled in with the item, price and your goal.
- **Claude (Anthropic API key).** Default model Claude Haiku 5.5. Make a key at platform.claude.com.
- **Any model (OpenRouter key).** Default `anthropic/claude-haiku-5.5`.

A Claude Pro or Max *subscription* can't be used to sign in to a third-party extension. If someone on the team has a Max, Ultra or Team plan, those include monthly API credits. Claim them in claude.ai under **Settings → Billing**, then make a key.

Keys are stored only in your own browser (`chrome.storage`). Don't commit them.

## Editing the judge's personality

`personality/judge.md` is the judge's character brief, and `personality/witness.md` is the expert witness's. They're plain Markdown sent to the model at the start of every AI turn. Edit, save, reload the extension. They don't affect scripted mode. For that, edit `LINES` and `QUESTIONS` in `src/script.js`.

## Files

| File | Job |
|---|---|
| `manifest.json` | MV3 manifest. Runs on amazon.com, amazon.ca and localhost |
| `src/flow.js` | Hearing rules: rounds, witness, extra round, recess, verdict |
| `src/script.js` | Scripted court: questions, reactions, witness lines, verdict reasons |
| `src/content.js` | Finds the item, pauses the checkout button, draws every screen (shadow DOM) |
| `src/background.js` | AI court (Anthropic or OpenRouter) and the Urbanist font |
| `personality/` | Judge and witness personalities for AI mode |
| `options.*`, `popup.*`, `ui.css` | Settings page and toolbar popup |
| `test/` | Mock Amazon cart and product pages for offline testing |

Debugging: open DevTools on the Amazon tab and filter the console by `[MM]`. It logs why a check-in did or didn't appear and how each answer was scored.

## Known gaps

- **API keys in the browser.** Fine for team testing, not for a release. A small proxy would fix that.
- **Amazon only.** Selectors were checked on live amazon.com in Nov 2026 and will drift.
- **Wishlist and reminders.** Saved items go to a list inside the extension. There are no reminders yet.
- **No price comparison.** The Figma deliberating screen shows "Comparing prices", which would need a price API.
