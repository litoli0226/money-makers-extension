# Guilty If Charged

Chrome extension prototype for our Persuasive Design project (team Money Makers). When you click a checkout button on Amazon (Buy Now, Proceed to checkout, Place your order), a **quick check** asks if you really need it. Save it, close it and carry on, or say "Yes, I want it" and make your case to **the judge** in a short courtroom chat. The verdict is advice. You always decide.

Screens follow the team's Figma file (Low-Mid-Fi Wireframes Iteration 2, "Hi-fi prototype"): quick check, saved pop-up, courtroom rounds, deliberating, verdicts, totally okay, home window and settings.

## Try it (5 minutes)

1. Download this repo: **Code → Download ZIP** and unzip it, or `git clone` it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick the unzipped folder.
3. The settings page opens. Add a savings goal if you want (or leave it blank).
4. Go to amazon.com or amazon.ca and click **Buy Now** on a product, or **Proceed to checkout** in your cart.

After pulling new changes, click the reload icon on the extension in `chrome://extensions`, then refresh the Amazon tab.

Nothing gets bought by the extension. It only pauses the checkout button and clicks it again if you choose to go ahead.

## How it flows

Follows the "User flow map" and "Update user Flow" diagrams in the team's Figma.

1. **Shopping online.** You add something to your cart.
2. **You click a checkout button.** Items on your skip list (groceries, medicine and so on) go straight through, no pop-up.
3. **Quick check pop-up.**
   - "You're right. I'll save it": the money counts toward your goal, the item goes to your wishlist.
   - "Yes, I want it": the trial starts.
   - "Never ask about this item": that item never triggers a check-in again.
   - X ("not now"): the order goes through, no guilt message.
4. **The trial.** "Leave trial" works in any round. It goes back to the cart with no verdict.
5. **The judge's verdict.** Either "Save it" or "Go for it", with a one-line reason drawn from your answers.
6. **You decide.** The verdict is advice.
   - Saving moves the money to your goal and the item to your wishlist.
   - "Go for it": straight back to checkout.
   - Appealing a "Save it" ruling and buying anyway: goes through "Totally okay, you thought it through", then the order continues. (The Figma flow shows this for every purchase. The team chose to skip it after an approval.)

## How a trial works

The rules are in `src/flow.js`, so key moments always happen for the same reason, whether the lines come from the script or from AI.

| Moment | When it happens |
|---|---|
| **4 rounds** | The default experience. |
| **3 rounds** | Low motivation (two short or "idk" answers by round 3), or the case is already clear (score +4 or -4 by round 3). The verdict comes early. |
| **Expert witness** | Once, after answer 2, only if the case is too close to call (score -1 to +1). Price arguments call the price analyst, need or usage arguments call the cost-per-use analyst, anything else calls "future you". |
| **Recess, then 4+ rounds** | After the last round, if the case isn't settled: either your last answers were on the fence ("maybe", "still thinking", "trying"), or it's leaning yes but hasn't cleared the bar. The court calls a short recess and adds a round, up to 6. |
| **Verdict** | Score +2 or more: go for it. Anything less: save it. |

Each answer is scored strong (+2), good (+1), neutral (0), weak (-1) or impulse (-2). It's also flagged if it's low effort or on the fence. In scripted mode the scoring comes from keywords in `src/script.js`. In AI mode the judge model scores it using the rubric in `src/background.js`, but it never decides what happens next.

## Who runs the court

Pick in **Settings → Court settings**.

- **Scripted (default, free).** Canned lines in `src/script.js`, filled in with the item, price and your goal.
- **Claude (Anthropic API key).** Default model Claude Haiku 5.5. Make a key at platform.claude.com.
- **Any model (OpenRouter key).** Default `anthropic/claude-haiku-5.5`.

A Claude Pro or Max *subscription* can't be used to sign in to a third-party extension. If someone on the team has a Max, Ultra or Team plan, those include monthly API credits. Claim them in claude.ai under **Settings → Billing**, then make a key.

Keys are stored only in your own browser (`chrome.storage`). Don't commit them.

## Editing the judge's personality

Everything in `personality/` is plain Markdown that gets sent to the AI on every turn. Edit, save, then reload the extension.

- `judge.md`: the judge's character brief.
- `witness.md`: the expert witness's character brief.
- `example-trials.md`: sample hearings written by the team. The AI matches their voice, pacing and length, but never their facts. Add, edit or replace trials freely. Including a mix of outcomes helps.

None of these affect scripted mode. For that, edit `LINES` and `QUESTIONS` in `src/script.js`.

## Files

| File | Job |
|---|---|
| `manifest.json` | MV3 manifest. Runs on amazon.com, amazon.ca and localhost |
| `src/flow.js` | Hearing rules: rounds, witness, extra round, recess, verdict |
| `src/script.js` | Scripted court: questions, reactions, witness lines, verdict reasons |
| `src/content.js` | Finds the item, pauses the checkout button, draws every screen (shadow DOM) |
| `src/background.js` | AI court (Anthropic or OpenRouter) and the Urbanist font |
| `personality/` | Judge and witness personalities, plus example trials, for AI mode |
| `options.*`, `popup.*`, `ui.css` | Settings page and toolbar popup |
| `test/` | Mock Amazon cart and product pages for offline testing |

Debugging: open DevTools on the Amazon tab and filter the console by `[MM]`. It logs why a check-in did or didn't appear and how each answer was scored.

## Known gaps

- **API keys in the browser.** Fine for team testing, not for a release. A small proxy would fix that.
- **Amazon only.** Selectors were checked on live amazon.com in Nov 2026 and will drift.
- **Wishlist and reminders.** Saved items go to a list inside the extension. There are no reminders yet.
- **No price comparison.** The Figma deliberating screen shows "Comparing prices", which would need a price API.
