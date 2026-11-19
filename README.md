# Guilty If Charged

Chrome extension prototype for our Persuasive Design project (team Money Makers). When you click a checkout button on Amazon (Buy Now, Proceed to checkout, Place your order), a **quick check** asks if you really need it. Save it, close it and carry on, or say "Yes, I want it" and make your case to **the judge** in a short courtroom chat. The verdict is advice. You always decide.

Screens follow the team's Figma file (Low-Mid-Fi Wireframes Iteration 2, "Hi-fi prototype"): quick check, saved pop-up, courtroom rounds, deliberating, verdicts, totally okay, home window and settings.

## Try it (5 minutes)

1. Download this repo: **Code → Download ZIP** and unzip it, or `git clone` it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick the unzipped folder.
3. Nothing opens on install (no onboarding in the guest-trial MVP). To change switches, click the extension's toolbar icon → Settings, or Details → Extension options in `chrome://extensions`.
4. Go to amazon.com or amazon.ca and click **Buy Now** on a product, or **Proceed to checkout** in your cart.

After pulling new changes, click the reload icon on the extension in `chrome://extensions`, then refresh the Amazon tab.

Nothing gets bought by the extension. It only pauses the checkout button and clicks it again if you choose to go ahead.

## Branch `guest-trial-mvp`: the guest-trial MVP

This branch adds the team's MVP trial next to the classic one. It follows the
rules doc "Money Makers: rules the judge runs on (MVP)"; the R and C codes below
match it. **Settings → Court settings → MVP test switches** picks the format and
the options the team hasn't settled yet.

The MVP spine (R6), after a **court notice**, styled as a summons: the judge's face in a gold ring beside "SUMMONS", then "Your case: spending 1.1 tanks of gas on this candle.", the tank gauges, "Plead your case and get the court's opinion before you buy.", "Take it to court" with "2 min" inside the button, "Skip court", a centered "Don't ask about this item", and a one-line privacy notice with a link to `privacy.html`. Gas price comes from the state in Amazon's "Deliver to" ZIP (AAA state averages, Nov 18, 2026, in `STATE_GAS`, `src/prices.js`; 14-gallon tank), or the US average when there's no ZIP; tanks show to one decimal. The noun comes from `itemNoun()` ("this candle", "these headphones"); unknown items read "this purchase", carts "these 2 items".

1. **Meet the judge.** After "Take it to court", a screen of its own: "All rise.", the judge rises behind the bench and asks "Forgive me, what's your name, defendant?" The name step is a plain web form, "FORM GIC-1, Defendant information": a Title dropdown and a dashed, read-only Last name field that already says Moneybags ("Not editable"; clicking it shakes the field and says "You cannot change your own last name.", then "Please don't try to change your last name. We know who you are."). "Start" strikes the gavel ("Court is in session.") and opens the courtroom with the item on the wall as Exhibit A (its Amazon photo when the page has one). No AI call, and the title pick doesn't count as an input (C1 option a).
2. **Item, price, how.** The judge names the item and price from the page, adds one price line from `src/prices.js` (R11), and asks how it will make your life better.
3. **Objection, once (R7).** If the answer is a reason rather than a mechanism, the judge raises an eyebrow, says "Not why, defendant. I asked how." and asks once more. Then it moves on.
4. **Witness, every trial, after two answers.** If the judge didn't object, it asks one follow-up first ("How often, exactly?"). The witness is drawn at random from the ones that fit the case (research, cost-per-use, price, Future you, the item itself, your wallet), never the same one two trials in a row, and takes a random side, for or against. The judge asks it a charged question ("Wallet, you've seen $210 leave before. How did it go?") before it testifies. Same model, separate requests (C5): `mvp_charge`, then `mvp_witness`.
5. **Respond** to the witness (skipped after an objection when C1 option b is on).
6. **Deliberate.**
7. **Verdict and sign-up.** Case approved, Sleep on it, or Case denied (R15, wording in `MVP_VERDICTS` in `src/content.js`), plus a sign-up card whose line fits the case. There's no account system: the email stays in the browser (`signups` in storage).

The verdict comes from the score by default: each answer is scored as before, a mechanism counts one step stronger, a reason one step weaker, and a confirmed gift adds 2 points. +2 or more approves, -2 or less denies, anything between is "sleep on it" (C2 rule). Set C2 to "model" to let an AI court pick instead.

| Switch | Code | Default |
|---|---|---|
| Trial format | | MVP |
| Minimum total for a trial | R5 | $1 |
| Court notice (consent) before the trial | R5 | On |
| Skip "respond" after an objection | C1 | Off (option a) |
| Who picks the verdict | C2 | The rule |
| Gift buttons | C4 | Off |
| Live "how, not why" hint while typing | | Off |
| Temperature (OpenRouter) | R11, R16 | Model default |

Try it offline: `npm run preview`, then open `http://localhost:8765/test/cart/preview-mvp.html?item=candle` or `?item=headphones` (the two R18 test products). URL options: `gift=on`, `skip=on`, `hint=on`, `notice=off`, `min=50`, `format=classic`. The console (`[MM]`) logs each trial's seconds and typed inputs, for the R3 under-60-seconds check; both are also saved in the history entry.

**Who's in court changes per trial.** `src/cast.js` holds 8 judge and 8 witness presets: fixed combinations of 6 skin tones, hair style, hair color and glasses. Each trial picks one of each at random (logged as `Cast:` in the console and saved with the trial). See them all at `http://localhost:8765/test/cast.html`. Add or edit presets there; keep colors from its `SKIN` and `HAIR_COLOR` lists.

**Privacy** (`privacy.html`, opened from the notice's "Privacy policy" link): what the extension reads and keeps, where it goes, guest mode, AI mode, and how to erase it. It is a draft: keep it true to the code. In AI mode with OpenRouter, requests carry `provider: { data_collection: "deny" }`, so OpenRouter routes only to hosts that don't store or train on prompts (Settings → "Data policy for OpenRouter hosts" can switch this to "allow"; the policy page would then need changing).

**Time-left bar.** The MVP top bar shows an estimate, not a clock: "About 2 minutes left" with an empty bar that fills by step. Seconds per step are in `EST` in `startMvpTrial` (`src/content.js`); an objection adds time to the estimate but the bar never moves backward.

Not done on purpose (MVP rules): the restate step, the risk question and the eyewitness are cut (R8); live prices and Amazon logins are out (R4). The witness still uses a separate request, because "not a second LLM" (C5) is already true: it's the same model.

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

### Guest mode and the goal invitation (Nov 19)

- **Guest by default** (switch: Settings → MVP test switches → Guest history, `hold` or `keep`). An MVP trial's records wait in memory and are written to history and the wishlist only if the defendant sets a savings goal at the end. Leave without one and the court forgets the case. "What the court keeps" says so.
- **The invitation** at the verdict is no longer an email form. The judge invites a savings goal, written from the trial ("That's $210 still yours. Set a savings goal, and the court will keep count."), and "Set my goal" opens the team's goal sheet (Figma 16.1, `showGoalSheet`). Saving the goal keeps the case and returns to the verdict: "Goal set: Spring break, $600. The court will keep count."
- **Courtroom:** the opener is "We are here in the matter of Mr. Moneybags v. the candle, $34." (how real judges open a hearing). No "Court is in session" or "The court enters Exhibit A" lines; Exhibit A is on the wall from the start. No figure at the defendant's table. Chat avatars are the judge's face. Stage directions are set like a script: left-aligned, italic serif, in brackets.
- **Non-answers** ("Um", "idk") get "\"Um\" is not something the court can write down." instead of "Not why, I asked how."


### The judge's opener (Nov 19)

Every trial opens with a joke about the judge's absurdly rich past, picked at random from `ANECDOTES` in `src/prices.js` ("Mr. Moneybags, you have brought before the court a $48 purchase. I bought my first yacht with that same amount. What are you spending it on?"). Then [The judge leans in to read Exhibit A.] (eyebrow up, the exhibit card glows) and a jab from `JABS` built on the price table ("A $48 candle. I guess you don't like movie tickets, Mr. Moneybags, as that's 3 movie tickets."). The code picks the joke, so variety doesn't depend on temperature; in AI mode the joke goes to the model in the case file and the model may reword it. Writers: add to `ANECDOTES` and `JABS` freely.

The Exhibit A photo shows a grey box that pulses (three times, under 5 s, none with reduced motion) while it loads, and stays a plain grey box if the photo never arrives. Amazon's lazy-load spinners and pixel placeholders are skipped.
