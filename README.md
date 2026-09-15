# stocktradingapp — Market Prep

Automated pre-market research for a stock watchlist. Every weekday morning it
measures your symbols and writes one self-contained HTML report with price
levels, Fibonacci, chart patterns and intraday reference levels — ready before
the open.

Runs on Node alone. **No `npm install`, no dependencies, no build step.**

---

## The hosted site

Published to GitHub Pages on every push to `main`, and rebuilt on GitHub's own
machines every weekday evening after the close, with further attempts through
the early morning:

**https://martinez90177.github.io/stocktradingapp/**

| Page | What it is |
|---|---|
| `/` | The morning report |
| `/practice.html` | The practice terminal |
| `/journal.html` | The journal |

Save the first link to a phone home screen and it behaves like an app. Because
the rebuild runs on GitHub, the site is current each morning whether or not this
computer is switched on -- which the local Windows scheduled task cannot do.

**Why evenings.** GitHub starts scheduled jobs late on this repository -- in its
first week, the 8:20am and 9:25am runs began between 12:31pm and 2:17pm every
day, so the link showed the previous afternoon's report at the open. An evening
build can be five hours late and still land long before the next open, and
everything that comes from the completed session (levels, fibs, patterns,
grades, the prior-session read) is correct in it. The morning runs remain, to
add the premarket when GitHub gets to them in time.

**The report says which kind of build it is.** Next to the build time, a label
computed in the browser reads *Includes today's premarket*, *Levels from the
last close · premarket not in yet*, or *Out of date* -- with its age. It is
worked out from the clock when you open the page, so it stays true on a copy
your phone cached yesterday. Market holidays are not modelled: the day after
one reads a day staler than it is, which errs in the safe direction.

Two things are deliberate about what does and does not get published.
`journal.json` is gitignored, so the hosted journal builds empty and real trade
history never leaves your own machines. `sessions/` **is** committed, because
Yahoo serves only seven days of one-minute history and the practice terminal
would otherwise fall back to generated candles.

The repository is public, which is what makes the free Pages link work: anyone
with the URL can read the report, and `watchlist.json` is readable by anyone
browsing the code.

---

## Where things are

| Path | What it is |
|---|---|
| `watchlist.json` | The symbols and options. **This is the file you edit.** |
| `reports/latest.html` | Always the newest report. Bookmark this one. |
| `reports/YYYY-MM-DD_HHMM.html` | Dated archive, newest 40 kept |
| `logs/run.log` | What the scheduled runs did |
| `run.ts` | Entry point for the full report |
| `lookup.ts` | Ad-hoc ticker lookup |
| `serve.mjs` | Local viewer plus the live lookup box |
| `publish-site.mjs` | Builds the `site/` folder for hosting |
| `rules.json` | Your trading rules. **Yours to edit.** |
| `journal.json` | Your trades and playbooks. **Yours to edit.** |
| `import-trades.ts` | Imports a thinkorswim statement |
| `src/vendor/practice-app.html` | The practice terminal |
| `sessions/` | Recorded real trading days, grows each run |
| `Setup-Schedule.ps1` | Registers / removes the Windows scheduled task |

Because this folder lives in OneDrive, the reports sync to your phone and
MacBook on their own. Open `reports/latest.html` from the OneDrive app on any
device. Once the file is downloaded it works **fully offline** — there are no
scripts, fonts, images or CDN links in it, and the charts are inline SVG drawn
at generation time.

## Changing the watchlist

Edit `watchlist.json`:

```json
{
  "symbols": ["SPY", "QQQ", "AAPL", "NVDA"],
  "options": {
    "dailyLookbackDays": 180,
    "intradayDays": 2,
    "maxConfluenceLevels": 9
  }
}
```

Symbols are Yahoo Finance tickers, so `BRK-B`, `^VIX`, `BTC-USD` and `ES=F` all
work. A symbol that cannot be fetched is listed as a failure at the top of the
report and dropped — never filled in with an estimate.

## Running it by hand

```bash
node run.ts
```

Useful flags:

```bash
node run.ts --symbols TSLA,AMD,PLTR   # ignore watchlist.json for this run
node run.ts --no-cache                # force fresh data
node run.ts --no-movers               # skip the movers scan
node run.ts --no-options              # skip the options chains
node run.ts --no-replay               # skip recording sessions for practice
node run.ts --open                    # open the report when it finishes
```

## Looking up any ticker

Two ways, both running the exact same analysis the morning report runs — so a
level you look up at 11am is computed the way the 8:15 run computed it.

**From the terminal.** Prints the level table and writes a page:

```bash
node lookup.ts TSLA
```

```bash
node lookup.ts TSLA,AMD,PLTR --open
```

Add `--quiet` to skip the terminal dump, `--fresh` to bypass every cache.

**From the browser.** Start the viewer and use the lookup box in the corner of
any page:

```bash
node serve.mjs
```

Then `http://localhost:8099`, or `http://<your-pc-ip>:8099` from a phone on the
same Wi-Fi. The box takes one ticker or several (`TSLA AMD`), and every result
is also saved to `reports/lookup-<TICKER>.html` so you can reopen it later
without the server.

The lookup needs a connection — it is fetching live data. The saved morning
report stays fully offline; the lookup box exists only in what the server hands
out, never in the file itself.

## Practice

A **Practice** link in the header opens a second page: a bar-by-bar replay
terminal for rehearsing entries, stops and exits. Step the chart forward one bar
at a time, draw on it, take shares or options, and manage the position — with a
Chain, Fib, Tape, Journal, Coach, Session and Rules pane alongside. It trades
the account you actually have, under the rules you wrote for it, and keeps a
record of every trade; see *Your account, your rules* below.

### The layout

The terminal is **one screen that never scrolls**, on a phone and on a
desktop alike. The header carries the ticker, the price, the clock and the
account strip; the chart takes everything that is left; and the panes live
beside it or over it, scrolling by themselves.

On a **desktop** it is laid out the way a charting terminal is: a toolbar of
timeframes, chart style and indicator chips above the chart, the drawing
tools down its left edge, the transport row (rewind, Next, play, speed)
under it, and a sidebar on the right with the day picker, the eight pane tabs
as two rows of four, and the pane. A slim masthead above it all holds the
data note behind a chip, the guide, and the link back to the report.

On a **phone** the same parts are stacked: header, chart, one toolbar row, the
transport row, and a bar of four buttons along the bottom -- Trade, Chain,
Session, More. The toolbar shows one of three things at a time, picked by the
icons at its left: the timeframes, the drawing tools, or the chart style and
indicator chips. A pane opens as a **sheet** that slides up over the lower part
of the chart and stops above the transport row, so Next stays under your
thumb with the ticket open; drag its handle down to close it, up for the full
height, or tap the button that opened it. The sheet's own tab row reaches
every pane; More opens the ones the bar does not name and takes that pane's
name while it is open. The day picker, Restart and the data note sit at the
top of the Session pane, and the shuffle button in the header is New day.

The app's markup and stylesheet are the single source for both: the build
adds the report's fonts and the masthead and nothing else. It used to
replace the stylesheet with a copy kept in `src/practice.ts`, and the two
drifted until the file opened from disk and the site served were different
pages.

### Finding your way

A **guide** walks through the page one control at a time: a spotlight on the
thing and a card saying what it does. It opens by itself on a first visit, and
from the **?** beside the day picker (the Session pane on a phone) or **How to
use this page** in the desktop masthead after that. The dimmed page cannot be
clicked while it runs, so the tour cannot place a trade. On a phone each step
opens the sheet or switches the toolbar to the thing it is pointing at.

Every drawing tool is labelled under its icon (Pointer, Trend, Level, Fib, Box,
Measure, Erase, Undo, Clear) and has a hover description. Picking a tool, or
switching an indicator on, shows a short note over the chart saying what it
does, since a phone has no hover.

**Drawings can be moved.** With the pointer, drag an end of a trend line, fib,
box or ruler to reshape it, drag its body to move it whole, and drag a price
level up or down; the selected drawing shows its handles, and Delete removes
it. A drawing lands where the pointer is rather than on the nearest bar's
centre, which is what made every line jump into place as it was drawn, and
the magnet -- ends snapping to a nearby open, high, low or close -- is off
unless you switch it on, and gentler when you do. After each drawing the
pointer comes back by itself, so the next drag pans or moves what you just
drew instead of drawing another.

### The ticket

**The ticket is where you trade.** The call and the put at the chosen strike sit
side by side as cards, and **tapping a card buys it** -- there are no separate
Buy buttons. Each card shows what that side costs (the ask), its bid, delta and
breakeven, and on its action line exactly what the tap will do: *Buy 3 calls*,
*Limit order · 3 calls*, *Add 1 call*. A side you cannot take right now -- a put
while you hold a call, anything after the bell -- is greyed out with the reason
on it. In Shares mode the cards are Long and Short. Size and order type sit
above the cards, so they are set before you tap; on a keyboard, L and S do the
same as the two cards.

Each card shows how far that contract has moved since 9:30. An open position
shows its P&L in dollars **and percent**, in the ticket and in a bar in the
header that stays in view while you watch the chart; the tape's closing line
gives the return on the premium paid.

Above the cards sits **the plan**: which setup this is, and a stop and a target
on the stock's price. It is above them on purpose -- entry, stop and target
before you click -- and under the rules below a card stays refused until the
plan has what they require, with the reason written on the card.

The Chain tab picks a strike and brings you back to the ticket; it does not buy.
A one-tap buy in a dense table is too easy to hit by accident.

During a replay the ticket's numbers update in place and it is rebuilt only when
what it shows changes shape -- a new position, strike or order type. It used to
rebuild on every bar, which would swallow a tap that landed mid-rebuild and
threw away whatever was being typed in the stop box.

Strike and size have steppers. Expiration is labelled today / next day / a week
out rather than only 0DTE, 1DTE, 7DTE.

**Stops and targets besides the fib.** The plan's chips set them from what is
on the chart: a stop at the range edge or mid-range, or at the **last swing**
(the last pivot the auto-fib found, which is where the read is wrong); a
target at the 127% or 162% extension, at the **next level** in the trade's
direction (yesterday's high, low or close, the pre-market high or low, the
open, or the range edge -- levels are where the other side's orders sit), at
**2R or 3R** (a multiple of the distance to the stop, so the reward is in
units of the risk; needs a stop), or the **measured move** (the opening
range's height projected past its edge). Worth knowing but not chips: ATR
multiples, VWAP as a mean-reversion target, and strikes as magnets on names
with heavy option volume.

The **exit plan** is a stop and a target on the stock's price. A stop below the
price only makes sense for an upside trade and above it only for a downside
one, so the ticket works out from the stop which side you mean and prices the
risk, the reward and the ratio for that side. The old one always priced a call.
A stop and target on the same side get a warning, and pressing Buy with a stop
on the wrong side of the price is refused rather than opening a trade the next
bar would close.

### Your account, your rules

The simulator trades the account you actually have, under the rules you wrote
for it. An **account strip** under the header shows the balance, today's P&L,
how much of the day's options allowance is used, the trade count and the loss
limit; tap it for the record. The **Rules** tab holds the numbers, and beneath
them the whole of Alex's Rules from `rules.json`, so each rule and the number
that enforces it sit together.

The defaults: a **$1,000** account, at most **$200 of options bought a day**,
a **$60 daily loss limit**, **three trades a day**, at most **$60 at risk to
the stop** on any one trade, a **$0.65 fee a contract each way**, and **ten
minutes off after two straight losses**. All of it is editable and saved in
the browser, and the account can be set to any amount at any time (below).
The record began when the default was $500; a browser that already has a
record and never set its own starting balance keeps $500, written into its
saved rules, so the new default cannot move an existing balance.

With the rules on, a card **refuses** anything outside them and says which
rule, on the card: *Name the setup first*, *Set a stop first*, *Daily cap used
up*, *Over the daily cap · 1 fits*, *Risks $76.00 · max $60.00*, *Trade limit
reached*, *Daily loss limit hit*, *Cooling off · 8 min*, *Never add to a
loser*, *Too late for a 0DTE* (after 3:30), *No shorting in a cash account*. A
stop on an open position may move closer but never further: type a wider one
and the box is put back, with the rule on the tape. The refusals are re-checked
every bar, so a cool-off that ends re-enables the card by itself. A line under
the cards says what fits right now -- *$82.00 of $200.00 left to buy today · 1
call or 2 puts fit here* -- and warns, without refusing, on a planned reward
under 1.5x the risk, an entry within three minutes of a loss, and a green day
worth protecting.

With the rules **off**, nothing is refused and every breach is recorded against
the trade instead: no stop, no setup named, moved the stop away, revenge entry,
skipped the cool-off, past the daily loss limit, over the trade count, over the
daily cap, oversized, added to a loser, late 0DTE, thin reward, held into
expiry. Each trade carries a **discipline score** out of 100 -- a serious
breach costs 25, a minor one 10 -- and the Coach lists every breach with the
rule it broke. The score grades the execution, not the outcome: a well-executed
loser scores 100.

Fees are real: $0.65 a contract each way by default, charged as each clip
closes, so a trade scaled out in pieces pays exactly once per contract and a
trade that is rewound never paid at all. Every P&L on the page is net of them.

### The record

Every closed trade and every session is written to a **record** kept in the
browser, and the account balance is the starting balance plus that record. The
Rules tab can **set the account to any amount at any time** -- to match what
the real account actually holds after a deposit, a withdrawal or a real trading
day -- and put it **back to the starting balance** in one tap. Neither touches
the record: the balance simply counts from that moment, and the track record
says when it was last set.
Trades reach it at the **4:00 bell**, when you press **End the day** in the
Session tab, or on the way out to another session -- never the moment they
close, because a rewind must be able to unmake a trade. A day with no trades is
still recorded when it ends; the skips are evidence of discipline.

The bell opens a **debrief**: today's result and discipline score, two lines --
what would you repeat, what would you not -- and a grade for the execution,
saved with the session. It names the day even on a blind one -- it is over, so
the hindsight is free now -- and under it is **what the day offered**, which
also appears in the Coach tab from the bell and never before:

- **The playbook trade, no hindsight:** the first 5-minute close out of the
  opening range, as steps -- the time and price, which 0DTE contract to buy
  and what it cost (and whether it fit the cap, or which strike would), the
  stop at the far side of the range and the dollars at risk, the 127% and
  162% targets, then what happened: which target was hit when, or the stop,
  and the result on one contract after fees. A day with no breakout says
  sitting out was the trade.
- **What the day offered, hindsight:** the biggest move of the day, priced
  as the at-the-money 0DTE contract bought at its start and sold at its end,
  with when it started relative to the breakout and how long it ran. Nobody
  buys the low; the lesson is where the move was.
- **You:** your trades beside it.

Tap the account strip for the **track record**: net, win rate, profit factor,
expectancy, average R, average win and loss, max drawdown, discipline, days
practised and the current streak; an equity curve with the largest drawdown
shaded; **what the habits cost**, every broken rule totalled in dollars (a
habit in profit is listed too, on purpose); performance by setup, ticker, time
of day, expiry, day of the week and time in the trade; then the sessions with
their debriefs. Filters show only trades taken with the rules on, or only those
with no rewind and no repeat of a day already traded. Copy or download the
record to keep it, or to carry it to another device, where pasting it merges
trade by trade.

### Surprise me, from the whole library

The page embeds only the newest days, so it stays one file that opens from
disk. Beside it the build publishes **the whole recorded library** as one pack
per ticker (`site/sessions/<SYM>.json`, with an `index.json` of what is
there). **Surprise me** in the Session tab -- any ticker, or any day of this
one -- and **New day** in the header draw a random day from that library:
fetched on demand, with up to a month of history behind it, preferring days
with a fortnight of history and days not served before (kept in the browser,
so the next surprise is one you have not had). The picker stays on the newest
twelve. Where the packs cannot be fetched -- the page opened from disk -- the
embedded days stand in and the tape says so.

The library grows by a day per ticker per run and nothing ages out of it, so
the pool only gets harder to learn. It starts at 21 days per ticker, which is
Yahoo's reach; after a couple of months of runs it is genuinely large.

### Blind days and hardcore

Two switches in the Rules tab change the replay itself. **Blind days**, on by
default, hide which date is being traded -- the day picker, the time axis and
the tape all say *blind* -- and reveal it at the bell and in the debrief, so a
day you remember cannot be traded on memory. **Allow rewind** off is hardcore: what happened, happened, and the
back arrow is dead. The record marks trades taken after a rewind, and trades on
a day already traded before, so the filters can leave them out.

### Option prices

The candles are recorded. Option prices are recorded too on any day the
recorder above was running; on every other day they are modelled, because
Yahoo keeps no history to fetch. What makes a model honest is the volatility
in it, and that is the market's own, not a guess:

- **The level** comes from the day being replayed: VXN (Nasdaq-100 options) for
  most tickers, VIX (S&P 500 options) for SPY, read at the minute on screen and
  never ahead of it. Days recorded before minute data was kept use that
  morning's opening level. It lives in `volatility/`; every local run adds the
  new days.
- **Each ticker** is scaled by how its own options trade against that index,
  measured from real trades by `node tools/calibrate-vol.mjs` -- QQQ at 0.93x
  VXN, TSLA at 1.73x, NVDA at 1.45x -- and its skew is measured the same way.
  The local morning run re-measures every ticker each day, so the scaling
  follows the market. A ticker never measured is priced like the typical
  measured stock, and the ticket says so.
- **The clock** is the one the market keeps, not the one on the wall. A
  session's variance is not spread evenly across its minutes: measured from the
  recorded bars by `node tools/measure-intraday-variance.mjs`, the first half
  hour carries about **a third** of the day and the last half hour about a
  twentieth. A 0DTE at 3pm has a sixth of the session left but a **thirteenth**
  of its variance. The measured curve lives in `volatility/intraday.json`.
- **Spreads** follow the exchange's ticks: SPY and QQQ a cent or two wide, stock
  options in pennies under $3 and nickels above. You buy at the ask and sell at
  the bid.

The ticket says where the volatility came from, e.g. *"VXN at 10:30 was 22.07;
QQQ options trade at 0.93x VXN (measured 2026-09-10); 51% of the session's
variance is still ahead at 10:30 (an even clock would say 85%)"*.

### Recording the real quotes

A model can be made honest. It cannot be made exact, and a size you cannot
scale from is worse than useless. So the option prices are recorded too, the
same way the candles are:

```bash
npm run schwab-login      # once a week: sign in to thinkorswim
npm run check-feeds       # which feeds are live, and how far behind?
npm run record-options    # then record until the bell
```

Start it before the open and leave it until the bell. Every minute it reads the
real chain for each watchlist symbol and files the **actual bid and ask** of
every strike near the money into `options/<SYMBOL>/<DATE>.json`. From the first
day it runs, the practice terminal quotes those numbers: a fill is the ask that
was really showing at 10:07, and an exit is the bid that was really there at
11:52.

It is a long-running process, not a cron job, and that is the catch. **No free
feed serves option history**, so a session nobody recorded is gone for good.
That is why `options/` is committed, like `sessions/`, and why the days already
in the library stay modelled: they cannot be recovered short of buying the
history from a vendor who kept it.

#### Which feed, and is it telling you about now?

Freshness is the whole game. A quote recorded at 10:07 is worthless if the feed
handed out 9:52's prices, and **Yahoo's option chain is usually about a quarter
of an hour behind** with nothing in the response to say so. So four feeds are
wired in, and none of them is taken at its word:

| Feed | Needs | Real-time? |
| --- | --- | --- |
| `schwab` | `SCHWAB_APP_KEY`, `SCHWAB_APP_SECRET`, plus a login | **yes**, for account holders, and it says so in the response |
| `tradier` | `TRADIER_TOKEN` | yes with a funded brokerage account; the free sandbox is delayed |
| `polygon` | `POLYGON_KEY` | on a paid options plan |
| `alpaca` | `ALPACA_KEY`, `ALPACA_SECRET` | with `ALPACA_OPTIONS_FEED=opra`; the free indicative feed is delayed |
| `yahoo` | nothing | no, and it will not admit it |

**Schwab is the one to use**, because thinkorswim is built on it: the data is
the same data the platform shows, it is real-time for account holders, and
alone among these it returns an `isDelayed` flag rather than leaving you to
infer it. A feed that declares itself delayed is treated as stale however
recent its timestamp looks, because a delayed quote is re-stamped as it is
handed out.

**The candles come from Schwab too**, once it is logged in: `fetchMinuteBars`
tries it first and falls back to Yahoo. So the chart being replayed is the
chart thinkorswim would have drawn, and the whole page runs on one feed.

#### Setting Schwab up

At [developer.schwab.com](https://developer.schwab.com): create an app, add the
**Market Data Production** product, and note the callback URL you register
(`https://127.0.0.1` will do). Then:

```bash
export SCHWAB_APP_KEY=...  SCHWAB_APP_SECRET=...
npm run schwab-login
```

That prints a link; you sign in with your Schwab credentials, approve, and the
browser lands on a page that will not load -- expected, the callback is not a
real server -- and you paste the address back. Tokens go to
`.schwab-tokens.json`, which git ignores and which is written readable only by
you.

An access token lasts thirty minutes and the recorder refreshes it by itself,
about a dozen times a session. **The refresh token lasts seven days**, so the
login is a weekly job; the recorder says how long it has left when it starts,
and warns if it will run out during the session.

Every feed is asked for **its own timestamp**, the gap from the clock is
measured on every single sweep, and that lag is written into the file beside
the quotes. Each minute goes to the first feed that answers fresh and falls
down the list when one is stale or down, so a session can be recorded from more
than one; the file records which feed supplied which minute.

`--check` sweeps every configured feed once and prints spot, lag, expiries,
strikes and a sample quote side by side, so you can see which are actually live
before committing a session to them. `--source tradier,yahoo` sets the order by
hand, and `--max-lag` (90 seconds by default) decides what counts as stale.

None of this is hidden afterwards. The tape says which feed a day came from and
how far behind it typically was, and where a recording was materially delayed
the ticket says so on the contract: *"the feed was about 15 minutes behind the
clock, so these are its prices from around 10:15."* A late quote clearly
labelled as late is worth having. A late quote passed off as this minute's is
not, and would be the same lie as generating it.

What it costs: about **1.6 MB a day** in the repository for three expiries
across seven tickers, once git has compressed it, so roughly 400 MB a year.
`--expiries 1` records only what expires today and cuts that to a third;
`--band` narrows the strikes; `--symbols` limits it to the tickers you actually
trade.

**Nothing is presented as a real quote unless it is one.** A strike, an expiry
or a minute nobody recorded falls back to the model, and the ticket says which
it is giving you, every time. A minute the recorder missed may borrow the one
before it, but only for two minutes: a quote from 1:58 shown as the price at
3:00 would be the same lie as generating it. Where a quote is real, the greeks
beside it come from the volatility that price implies rather than from the
model.

### One feed, not two

Everything recorded before 2026-09-15 came from Yahoo. That matters more than
it looks: the intraday variance curve and the overnight gap ratios are measured
across the **whole** library, and those numbers set option prices, so a library
with two vendors in it puts a seam inside the pricing.

So the library is meant to be replaced rather than mixed. Every session now
carries the feed it came from, `measure-intraday-variance` reports the mix and
warns when there is more than one, and two tools handle the switch:

```bash
node tools/compare-bars.mjs               # how far apart are the two feeds, really?
node tools/refetch-bars.mjs               # what would change; writes nothing
node tools/refetch-bars.mjs --write       # re-record the library from Schwab
node tools/measure-intraday-variance.mjs  # then re-measure what is derived from it
```

`compare-bars` fetches the same recent days from both and reports the worst and
median difference in the closes, the minutes one has and the other does not,
and how far apart the volumes are. Pennies and a few percent is two vendors
consolidating the same tape, and is fine. Dollars, or missing minutes, means the
seam is real.

`refetch-bars` re-records each day from Schwab, and is careful: a day is only
replaced where Schwab's session is **at least as complete** as the one on disk,
so a short or gappy answer can never quietly degrade a good recording. It
separates a day Schwab cannot reach at all from one it served with too many
minutes missing -- the second is worth trying again, the first is not -- and
leaves both alone, still tagged as Yahoo's. Nothing is written without
`--write`, and the library is committed, so a replacement is a reviewable diff.

### The clock, and why a flat volatility was not enough

A calibration is a volatility measured at some particular distance from expiry,
and that distance was being thrown away. The same QQQ expiry measured at the
2026-09-10 close, a full day out, was **21.6%**; measured at 13:28 the next day,
two and a half hours out, it was **7.9%**. Both were stored in one `ratio`
field and used as if they meant the same thing, held flat across the whole
replayed day on a clock that ran evenly. So the terminal charged the morning's
volatility all afternoon: a QQQ 0DTE at 3pm ran about **three times** what the
market charged for it, and a deep in-the-money contract carried time value it
had no business carrying.

The anchor is variance now, not volatility:

1. The calibration says what the market charged, at whatever horizon it was
   taken at. That is a quantity of variance.
2. Dividing by how many sessions' worth of variance stood ahead of it leaves
   the value of **one session** for that ticker.
3. The measured curve says what share of a session is still ahead at the minute
   on screen, and the volatility handed to Black-Scholes is whatever expresses
   that variance over the time still on the clock.

Both halves of the curve are measured **per ticker**, because they are nothing
like each other. The overnight gap is worth 0.11 of a session on AAPL and 1.09
on NVDA; pooling them priced the index ETFs about a third too dear. A ticker
with fewer than 15 recorded days falls back to the pooled curve, and the ticket
says which it used.

**Time decay** is the next hour of that curve rather than the Black-Scholes
theta, which assumes every minute decays alike. On the measured clock the first
hour of the day costs several times what noon costs, which is the whole reason
0DTE holders talk about the morning bleed.

Checked against the real prints from the afternoon of 2026-09-11, which the
model never saw (it prices that day from the 09-10 calibration): at-the-money
0DTE implied volatility of **9.1%** against a measured 7.9% on QQQ, 19.5%
against 21.4% on TSLA, 14.1% against 15.5% on MSFT. It was 2.5x out before.
The residue is a real thing rather than a modelling error -- the market's view
of 09-11 genuinely changed between the previous close and that afternoon -- so
it is left alone rather than tuned away.

What it replaced: a fixed volatility per ticker from when the app was written
(QQQ 17%, from when QQQ traded near 500; NVDA 50%; any other ticker 35%), marked
up 55% for 0DTE, with a smile that made every out-of-the-money option dearer.
On Sep 9 at 9:45 that priced the QQQ 720 call, 0DTE, at $3.48; it is $2.25 on
the market's volatility, and less again once the clock above is applied.

**How accurate.** Tested against 273 real option trades at the Sep 10 close,
on expiries the calibration never saw: median error **9%**, against 35% for the
fixed volatilities (NVDA 83% to 3%, TSLA 68% to 2%, AAPL 69% to 7%, QQQ 24% to
10%). The weakest are SPY (21%), MSFT (15%, where the old constant happened to
be close) and out-of-the-money calls two or more days out, which still run a
little rich. **Earnings are not modelled**: before a report real options are
dearer than this shows, and cheaper after it. So the ticket **warns** on any
contract whose life spans a report -- a 1DTE or 7DTE on NVDA on Aug 26, say, but
not that day's 0DTE, which expired before the after-close report. Report dates
live in `volatility/events.json`: the daily run files upcoming ones from the
earnings calendar, and NVDA's Aug 26 report is there from the +6.0% gap it left
on Aug 27, labelled as inferred.

### Moving through the day

The transport sits under the chart: **◀ rewind**, **next bar**, **play/pause**
and a **speed** picker from 0.5x to 8x. Arrow keys step, space plays.

**The day starts at the 9:30 open.** It used to start at 9:45 with the opening
range already drawn, which skipped the fifteen minutes that decide most days.
Now the first minute is on screen and the range forms at 9:45 as you get there
-- the band appears, the tape says how wide it is, and the range chips in the
plan wake up. Before then there is no range to break, and the Coach says so on
an entry taken while it was still forming.

Rewind is the point of a replay — you go back and take the other decision. The
whole trading state is snapshotted before every step, so going back unwinds
positions, fills, working orders and the tape together. Rewinding past an entry
means that entry never happened.

That has one consequence worth knowing: **closed trades are no longer sent to
the journal the moment they close.** A posted row cannot be retracted, and a
trade you rewind past should not survive in your record. They queue instead, and
go at the 4:00 bell or when you press **Send to the journal** in the Session
pane, which shows how many are waiting.

The Session pane also picks the day: **symbol and date** from the recorded
library, or *Surprise me*. **Jump to a time** fast-forwards to any point in the
session; it will not jump backwards, because that is what rewind is for.

### Orders

Market, **limit** and **stop**. With limit or stop armed, tapping a card in the
ticket places a resting order rather than filling one; working orders are drawn on the chart and
cancellable from the ticket.

A limit fills at its own price. **A stop fills at the worse of its price and the
bar open** — a market that gaps through a stop does not fill you at the stop, and
the log says when that happened. That gap is the whole reason stops disappoint
people, and a simulator that hides it teaches the wrong lesson.

An order placed on the wrong side of the market is refused with an explanation,
rather than resting and filling instantly on the next bar.

### The candles are real

Each replay is an **actual recorded trading day**, minute by minute, measured
from the market — not a random walk. A random one loads each time; the ticker
picker chooses which symbol, and **New session** rerolls the day.

Yahoo keeps about **30 days** of 1-minute history but hands out at most seven
days per request, so every run asks for the whole 30 a week at a time and files
any day it does not have into `sessions/`. The library **keeps growing by a day
per ticker per run**, and a week the computer was off fills itself in, as long
as it is within those 30 days. As of Sep 10 every practice ticker has **20
recorded days**, back to Aug 13.

The page embeds the newest **12 days per ticker to trade** -- counted per
ticker, because a total of 30 across seven tickers had left about four days
each -- and up to **10 older days behind them as history only**, carried at
5-minute bars so the daily and 4H views behind even the oldest pickable day
show a real fortnight. It used to embed the twelve and nothing else, so the
twelfth opened on three candles. History-only days are not in the picker and
carry no extended hours. The bars are embedded as whole cents from the previous
close, which is exact for two-decimal prices and about half the size; the
history days are a fifth of that again. Decoding was checked against the
recorded files, value for value.

Recorded: every ticker already in the library plus the first six on the
watchlist. It used to be the first six only, which quietly stopped recording
TSLA at Sep 4 once it sat eighth on the watchlist.

Minutes that genuinely had no trade are carried flat at the previous close with
zero volume — stating what happened rather than inventing a price — and any
session missing more than a dozen minutes is rejected outright.

**Pre-market and after-hours are recorded too**, from 4:00 to 9:29 and from
4:00 to 7:59 in the afternoon, as 5-minute bars, only where something traded.
Yahoo hands them out with the regular session (`includePrePost`), so every run
files them with the day, and a day filed before they were kept is given them
on the next run while Yahoo still has it. On the page they are the tinted
candles before 9:30 and after 4:00 -- the `ext hrs` chip, on by default -- and
the pre-market high and low join the levels. Five-minute rather than
one-minute bars keep twelve days of seven tickers to about 200 KB.

Off-hours the tape carries **bad prints** -- the odd late or odd-lot trade far
from the market that nothing follows, a $196.93 low on a $223 stock gone the
next minute. Left in, one sets the pre-market low and the chart scales to it
all morning. The recorder drops any extended-hours minute whose close is far
from both the bars before it and the bars after it -- a real gap, like an
earnings move, agrees with what follows and stays -- and clips a wick that
reaches further than that past its bar's own body. "Far" is the ticker's own:
four typical off-hours minute ranges, or 0.4% of the price, whichever is
more; a flat 1.2% let an $8 wick stand on a $716 ETF that moves a dime a
minute after the bell. Sessions carry `extv: 3` once cleaned, and the next
run redoes any that are not.

**Option prices are still modelled**, with Black-Scholes over the real
underlying, and fills are assumed at the mid. So the chart is real and the
option side is an approximation of the real chain. The banner on the page says
exactly this, and turns amber if no recorded sessions are embedded and it has
fallen back to the generator.

Skip the harvest with `--no-replay`.

### Reading the chart

Six chart types — candles, hollow, **Heikin Ashi**, OHLC bars, line and area —
from the picker in the toolbar. Heikin Ashi is built from the first bar
forward, because each of its candles depends on the one before it. The
indicator chips sit in the toolbar beside it, never over the candles: floated
over the chart they covered the first hour of the day. Any strip wider than
its box -- the chips, the timeframes, the tools and the tab row on a phone --
gets **arrows** at the edges that scroll it, since a hidden scrollbar is no
sign that there is more past the edge. On a desktop the eight pane tabs are
two rows of four, all in view, in the order they are reached for -- Trade,
Session, Coach, Chain, then Fib, Tape, Journal, Rules.

Indicator chips sit beside it: EMA 9/20/50, VWAP, Bollinger bands, an **RSI 14
subpanel**, volume, and magnet snapping for the drawing tools. Volume is drawn
as translucent bars along the bottom of the price pane, behind the candles,
the way TradingView does it; the band it used to have underneath read as a
separate section that the pane's tint and levels never reached. The price pane
is clipped, so a bar whose wick reaches past the scale no longer draws through
the panels and the time axis under it. A **levels**
chip, on by default, draws the prior day's high, low and close, the pre-market
high and low, and today's open -- the levels a day is traded against.

**Auto fib follows the last swing on the chart.** A high becomes a pivot once
price has come off it by more than a threshold (0.3% of the price, or three
typical bars, whichever is larger), a low once price has bounced that much --
the way a ZigZag finds swings. The levels run from the last confirmed pivot to
the extreme since, so they extend live as the leg runs, or across the leg
before it while the new one has not gone anywhere; the swing itself is drawn
faintly between its two dots. Before the day has a swing at all it uses the
day's range so far, and before that yesterday's; the Fib tab says which, with
the two ends and the threshold. It used to be the first fifteen minutes, fixed
for the day, which is one idea about a day and not the chart's. Off by default
-- turn it on with the `auto fib` chip, or draw one exactly where you want with
the fib tool. The opening-range levels are still in the Fib tab and behind the
`range` chip and the plan's range chips.

The chips are rendered from state rather than written into the markup, so a
default and its chip cannot disagree.

The default view shows fewer bars than it used to, because 80 candles across a
whole session squeezed the bodies to hairlines. Fewer bars means wider candles
*and* a tighter price range, so the bodies read at a glance. Zoom out for
context: pinch, scroll, or drag the time axis.

The price axis is draggable to stretch or squash the scale — the cursor turns
into a resize arrow over it — and scrolling there zooms the price scale alone.
Double-tap the axis to reset it, or press **Reset view**, which appears over
the chart whenever the view is not the automatic one.

Labels along the left edge -- the levels, a stop, a target, the strike, working
orders, drawn levels -- are laid out together at the end of each frame: sorted
by height and pushed apart until none overlaps, with a short tick from a moved
label to its line, which stays exactly at its price. Three levels within a
dollar of each other used to print three labels on top of one another.

There is deliberate empty space between the newest candle and the price axis. It
is sized to clear the level labels drawn along that edge, so 161.8% and PDH sit
in clear air instead of on top of the last few bars.

### On a phone

The page itself never scrolls, so Safari's address bar no longer collapses and
expands under a gesture, which used to change the chart's height mid-drag and
shift the whole page. The chart is exactly the box the layout gives it, on
every screen, and re-sizes only when that box does.

**Zoom.** iOS ignores `user-scalable=no`, and the old page had several ways
into Safari's page zoom and none out: a pinch with one finger off the canvas,
a double-tap on a strip, and -- the usual one -- tapping any input or select
smaller than 16px, which Safari zooms into and never zooms back out of. Every
control on a phone is 16px now, pinches and double-taps are intercepted, a
two-finger drag on the chart never scrolls anything underneath, and if the
page is ever found zoomed anyway a **Zoomed in · tap to reset** pill appears
at the top and puts it back.

The bar readout lives in the chart's corner, TradingView style, and the
position bar floats there too, under Reset view, so neither costs the chart
a line of header.

### Maintaining it

The app lives at `src/vendor/practice-app.html` and is now **maintained here** —
it started as an import but has since been patched for recorded data, the
scaling defaults and the axis behaviour. `src/practice.ts` swaps its stylesheet
and wraps it in the report's chrome; every class name in the app is load-bearing,
because its script builds panes by writing those classes, so the markup is left
alone.

> **Styles for the shipped page live in `SKIN` in `src/practice.ts`, not in the
> app's own `<style>` block.** `renderPractice()` replaces that block wholesale, so
> CSS edited in `practice-app.html` changes nothing on the built page — markup and
> script edits there *do* apply, which makes the failure quietly confusing: the new
> elements appear unstyled, laid out by rules written for the old ones. The app's own
> `<style>` is kept in step only so the raw file still renders when opened directly.
> **Change layout in both, or change it in `SKIN` and verify there.**

## Journal

A **Journal** link in the header opens the trading journal: what you took, what
it made, and what your habits cost.

### Getting trades in

**Import a thinkorswim statement.** In thinkorswim: Monitor → Account Statement,
set the date range, gear icon → Export to file → CSV. Then:

```bash
node import-trades.ts "C:/Users/GamerX/Downloads/AccountStatement.csv"
```

Add `--dry` to see what it would import without writing.

The export is a list of **executions, not trades** — a buy and a sell are
separate rows. The importer pairs them FIFO per instrument, so scaling out of
100 shares in two clips becomes two round trips with their own P&L, a short is
read from its sell-to-open, and options get their 100x multiplier. Positions
still open at the end of the file are reported and skipped rather than counted
as trades. Re-importing an overlapping date range is safe; duplicates are
dropped.

**Log one by hand.** The form at the bottom of the journal page. It needs the
local viewer running (`node serve.mjs`), because a plain file has nowhere to
save; opened as a file the form says so instead of silently dropping the trade.
P&L is computed server-side from the prices you enter, not taken on trust.

**Practice trades log themselves.** Every round trip closed in the practice
terminal lands in the journal automatically, flagged as practice.

### What it shows

Net P&L, win rate, profit factor, expectancy, average R, average win and loss,
max drawdown. An equity curve with the largest drawdown shaded. A calendar
heat-mapped by daily P&L. Performance by setup, and by mistake.

**Practice trades are excluded from every statistic.** They are stored beside
real trades and shown in their own block, because a rehearsal P&L blended into a
real win rate makes the number worse than not having one.

**What the habits cost** totals every trade tagged with a mistake. Habits
showing a *profit* are listed too, deliberately: a chase that got lucky is still
a chase, and a positive total is exactly how a bad habit stays invisible.

### R multiple

Profit divided by what was risked to the planned stop. It says whether a trade
was good *relative to the risk taken* — dollars flatter a big position and
punish a small one. It is blank on any trade with no planned stop, which
includes every imported one, since a broker statement does not record what you
intended.

### Playbooks

Named setups in `journal.json`, each with a checklist. Tag a trade with one and
the by-setup table tells you which of your setups actually make money.

## The website

```bash
node run.ts && node publish-site.mjs
```

That writes a `site/` folder: `index.html` (the report) and `practice.html`,
both self-contained. Open it from disk, drop it on any host, or let GitHub Pages
deploy it — `.github/workflows/pages.yml` builds and publishes on a push, on a
weekday schedule, or on demand from the Actions tab.

**Pages makes the report public.** Anyone with the URL sees the watchlist and
everything measured from it. If that is not what you want, leave the workflow
disabled and keep using the local viewer or the OneDrive copy.

The workflow's cron runs in UTC, so the two weekday builds drift by an hour when
the US changes clocks.

## Putting it on GitHub

The folder is already a standalone git repository — **separate from the Sports
Betting App**, different root, different history, no shared remote. Generated
output (`reports/`, `site/`, `cache/`, `logs/`) is ignored, so only source is
tracked.

```bash
git -C "C:/Users/GamerX/OneDrive/Market Prep" remote add origin https://github.com/martinez90177/stocktradingapp.git
```

```bash
git -C "C:/Users/GamerX/OneDrive/Market Prep" push -u origin main
```

Create `stocktradingapp` on GitHub first. **Consider private**: `watchlist.json`
holds the symbols you follow and `rules.json` is personal. Nothing here contains
credentials, but a public repo publishes both. Private repos need a paid plan
for Pages.

One caveat about `.git` inside OneDrive: sync and git collide if two machines
write at once. Fine from one machine; if you use several, clone from GitHub into
a normal local folder on each.

## Alex's Rules

A button in the header opens the rules popup. Press **r** anywhere, or open
`latest.html#rules` to land straight on it. **Esc**, the backdrop or the close
button dismiss it.

The rules live in **`rules.json`** and that file is the only author — whatever
you write renders, in the order you write it, grouped how you group it. Nothing
is merged in from a default set, because a rule you did not write is a rule you
will not follow, and a rule that reappears after you delete it is worse than no
rule at all.

```json
{
  "name": "Chasing",
  "rules": [
    { "rule": "If you missed the entry, you missed the trade.",
      "why": "The setup had a price. Above it, the odds are worse and the stop is wider." }
  ]
}
```

`why` is optional. A group with no rules is skipped. If the file is missing the
button simply does not appear; if it is malformed the run says so and carries
on without it.

The groups are numbered because they are a sequence, not a set of headings —
before you click, then the trap, then the money, then what to do when it turns,
then how the day closes.

## The look

**Typefaces are embedded, not linked.** Archivo for the interface, IBM Plex Mono
for every figure. They are inlined into the CSS as base64 woff2, because a
Google Fonts `<link>` would silently fall back to system faces on a phone with
no signal — which is exactly when this gets read. Costs about 170KB once.
Regenerate only if you change typefaces:

```bash
node tools/build-fonts.mjs
```

**The accent is deliberately none of the semantic colours.** Green means rising,
red means falling, amber means warning — so the indigo used for selection and
emphasis can never be misread as any of them. Neutrals carry a faint indigo bias
rather than being flat grey.

**The masthead runs a live clock** counting to the opening bell, to the close
while the session is open, or to the next open after hours (it jumps the weekend
on a Friday). Beside it, five figures orient you before you read anything:
symbols read, the top grade, how many are gapping over 1%, how many patterns
have triggered, and how many movers were found.

It does not know about market holidays, so on one of those it counts to an open
that will not happen.

## Reading the chart

The price axis carries the grid and **the last price, and nothing else**. Levels
are labelled on their own line instead, at the right end inside the plot, as
price plus the number of methods agreeing — `382.74  3x`.

Only the four levels nearest price get a label; the rest stay as faint lines,
with the full list in the table underneath. Every level used to claim its own
tag on the axis, which stacked the right edge into a wall of boxes and buried
the one number that always matters.

## Collapsing sections

Every tall block — the watchlist board, prior session, charts, levels in play,
full detail — is collapsible, on desktop and phone. **Collapse all** is in the
toolbar next to the ticker arrows.

Blocks collapse **by kind, not per symbol**: fold Charts once and it is folded
on every ticker, because the decision is about what you care about rather than
about one stock. The choice is saved in the browser and survives reloads, so the
report opens the way you left it. With scripting off every block is simply open.

Collapsed, the page is roughly a quarter of its full height — on a phone that is
about 5,600 pixels of scrolling down to 1,500.

## A URL you can open anywhere

`make-page.mjs` converts a finished report into a body-only fragment for hosts
that supply their own page skeleton:

```bash
node make-page.mjs
```

That writes `reports/page.html`. Because the report has no external resources,
the hosted page keeps working once loaded, the same as the file.

A hosted copy is a **snapshot** — it does not update when the 8:15 task runs.
Re-publish after a run to refresh it.

## Views

Two top-level buttons under the header: **Watchlist** and **Movers board**. The
movers scan is one click, not a scroll to the bottom. The choice is remembered
for the session, and a link to a specific ticker always lands on the watchlist.

## Viewing the charts

The detail section shows **one ticker at a time**. Pick it from the chips under
the header, click any card on the board, or use the arrows — left and right
arrow keys work too. The URL tracks the selection (`#t-NVDA`), so a reload or a
bookmark comes back to the same symbol. Tick **show all** to fall back to one
long page with every ticker, which is also what you get with scripting off.

## The schedule

Registered as the Windows task **"Market Prep - Premarket Report"**, running
weekdays at **8:15 AM** and **9:20 AM** local time. This machine is on Eastern,
so those are also market time. The first pass gives you an early read; the
second refreshes with the settled premarket high/low and gap right before the
open.

```powershell
# change the times
powershell -ExecutionPolicy Bypass -File .\Setup-Schedule.ps1 -Times "07:45","09:20"

# run it right now
Start-ScheduledTask -TaskName "Market Prep - Premarket Report"

# remove it
powershell -ExecutionPolicy Bypass -File .\Setup-Schedule.ps1 -Remove
```

If the machine is asleep at 8:15 the run happens on wake rather than being
skipped, and each run appends to `logs/run.log`.

---

## Reading the report

Each symbol opens with the six things worth knowing before the bell, then the
prior-session read, then charts, then the levels actually in play. Everything
else is behind the **Full detail** toggle at the bottom of each block, so the
default view stays scannable.

**Day-trade setup grade (A+ to D).** This measures how *tradeable* the session
looks, not whether a trade is a good idea. Six components: liquidity (dollar
turnover), daily range (ATR as a percentage of price, best between roughly 2%
and 5%), participation (relative volume), catalyst (premarket gap), how
decisively the prior session finished, and room to the next level. A quiet
mega-cap in a clean uptrend grades low, because there is nothing to capture
intraday. The full breakdown is under Full detail.

**Bias** is reported separately from the grade, because a stock gapping hard on
heavy volume is highly tradeable regardless of direction. It weighs the prior
session, daily structure, any triggered pattern and the gap — and it says so
when price opens right on top of a level, which is the case where a good-looking
setup has no room to work.

**Prior session read** is the candle analysis. Close location value is the
backbone: it runs -1 (closed on the low) to +1 (closed on the high) and answers
who had control when it counted. Alongside it: body and wick as fractions of the
range, range in ATR, volume against the 20-day average, and whether it closed
through the prior session's high or low. The wording tracks how decisive the
finish actually was, so a mid-range close is never called control.

### Candlestick shapes

Every place a symbol is described — the board card, the bias line, the detail
block, a movers card — leads with the candle.

Detected shapes, each with what it conventionally indicates on hover:

| Span | Shapes |
|---|---|
| Three bars | morning star, evening star, three white soldiers, three black crows |
| Two bars | bullish / bearish engulfing, piercing line, dark cloud cover, bullish / bearish harami, tweezer top, tweezer bottom |
| One bar | bullish / bearish marubozu, doji, dragonfly doji, gravestone doji, hammer, hanging man, inverted hammer, shooting star, spinning top, inside day, outside day |

Two things make this more than a shape lookup:

**Context decides the name.** A hammer and a hanging man are the *same candle*;
one follows a decline and is a reversal, the other follows an advance and is a
warning. Same for the inverted hammer and shooting star. Prior trend is measured
in ATR and used as an input, so these are never mislabelled.

**Reliability is separate from the shape.** Each detection is graded strong,
moderate or weak from range and volume — the same shape drawn on a quiet
narrow-range day is not the same statement as one on 2× volume across a wide
range.

**When nothing textbook fires, it says so and describes the bar anyway** — for
example *"Wide-range strong-bodied down bar, closing near its low"*, marked with
a dashed outline. Most sessions do not print a named pattern, and loosening the
thresholds until ordinary bars got named would invent shapes that are not there.

The read also counts streaks ("this is the third straight lower close"), which
is the context a single candle misses.

This is where the percentage change lies to you most often. A stock can close up
16% on a *wide-range strong-bodied down bar closing near its low* — gapped up,
then sold all day. The number says one thing; the candle says the opposite.

**Levels in play** shows only levels within about 2.5 ATR — the ones price can
realistically reach in a session. The complete list is under Full detail.

**Confluence is not a trade score.** The big number next to each level counts
how many *independent methods* land on that price — a Fibonacci retracement, a
moving average, the volume point of control and a prior swing all at once is a
level the market is watching from four directions. It rates **the price level**.
How good the setup is, is the letter grade at the top of the block. A 7-method
level can sit under a D-grade stock, and often does.

**Must hold** is the level that keeps the setup alive *today*. A pattern's own
invalidation is a swing level and can sit 30% away, which is no use before the
open; a breakout that has already triggered fails the moment price trades back
through the level it broke, so that is the line shown.

**Catalysts.** Chips under the plan strip flag what a chart cannot see: earnings
inside a week, a heavily shorted float, a low float, an ex-dividend date, a high
beta, and how many headlines landed in the last 24 hours. Hover any chip for the
reasoning. The full panel under Full detail carries the next and last earnings
dates, short interest with its month-over-month change, days to cover, float,
market cap, beta, and the recent headlines.

Earnings dates marked `*` are Yahoo's estimate, not confirmed by the company —
treat those as approximate. Earnings inside a day damp the bias, because a
result reprices a stock on information no chart contains.

**Headlines** are ranked so stories that actually name the symbol or company
come first; without that, generic market wraps ("Dow Jones Futures: Stocks
Jump...") crowd out the story that explains the move. Tags on a headline come
from **keyword matching on the title only** — nothing reads the article. They
mark what a story is about, and a direction is attached only where the wording
is unambiguous (`downgrades`, `prices offering`). The headline is always shown
so you can judge it yourself.

## Options chain

Under Full detail, each symbol carries the live chain lined up against its own
measured levels: three horizons (the next expiry, about a week, about a month),
and within each, the at-the-money call and put plus the strikes sitting on first
resistance and first support.

**This does not pick a contract for you, and it is not advice.** It puts the
numbers that decide one side by side:

- **Breakeven** — where the stock has to be at expiry for the premium to come
  back, and the percentage move that implies.
- **Move needed** — that move divided by what the stock typically covers over
  the contract's life, from its own ATR. **Under 1.00** means breakeven sits
  inside a normal move for that horizon. **Over 1.00** means the stock has to do
  something bigger than usual before you are even.
- **Liquidity** — open interest and the bid-ask spread as a share of the
  premium, graded good / fair / thin. This is the one that quietly costs money:
  a wide spread on a contract nobody trades bills you on the way in and again on
  the way out.
- **Delta** — computed from the quoted implied volatility using Black-Scholes,
  not reported by the exchange. Fine for comparing contracts, not a substitute
  for your broker's figure.

Above the tables, the implied daily move (from at-the-money IV) is set against
the ATR daily move. When implied runs well above ATR you are paying for movement
the stock has not been delivering; well below, and the market is pricing less
than it has been doing.

Options add up to three requests per symbol. Skip them with `--no-options`.

## Movers board

A side watchlist of what the market is actually moving, built from Yahoo's
gainers, losers, most-actives and small-cap-gainers screens. Names already on
your watchlist are excluded, and everything is filtered to a minimum price and
minimum average turnover, because a 40% move on $2M of volume is not a trade you
can get filled in.

Each card carries price and change, relative volume, dollar traded, ATR, a
sparkline, catalyst flags, the same prior-session candle read as the main
watchlist, and the most relevant recent headline. The long/short lean is
mechanical — prior session, size of move, trend structure, headline lean,
52-week position — and it says which of those drove it.

The board is for triage: it tells you which names are worth promoting into
`watchlist.json` for the full treatment, not what to trade.

Tune it in `watchlist.json`:

```json
"moversLimit": 12,
"moversMinPrice": 3,
"moversMinDollarVolume": 20000000
```

Set `moversLimit` to `0`, or pass `--no-movers`, to skip the scan entirely.

**Charts** pan and zoom: the `+` / `−` / `Reset` buttons, `ctrl`/`cmd` and
scroll, or double-click. Drag to pan once zoomed. On a phone, one-finger drag
pans and the buttons zoom. Plain scrolling always scrolls the page, so the chart
never traps the gesture.

## What it measures

**Levels** — every candidate below is priced, then levels within about a third
of an ATR of each other are merged into one:

- Swing pivots at three fractal widths, weighted by significance and recency
- 20 / 50 / 200 SMA, and the 52-week high and low
- Volume profile: POC, value-area high and low, high-volume nodes
- Fibonacci retracements and extensions
- Anchored VWAP from the 52-week high, the 52-week low, and the heaviest-volume
  session of the last quarter
- Unfilled gaps that price has not traded back into
- Prior day high / low / close, floor-trader pivots, premarket high / low,
  session VWAP
- Round numbers scaled to the price band

**Confluence** is the point of the merge. A level's score sums the weights but
adds a bonus for each *distinct* method that agrees, so a price where a 0.618
retracement, the 50 SMA, the volume POC and a prior swing high all land ranks
above four old swing highs stacked at the same price.

**Fibonacci** gets two draws: the dominant recent swing — picked by size in ATR,
how recently the leg ended and how cleanly it ran — and the full 52-week range.
Retracements at 23.6 / 38.2 / 50 / 61.8 / 70.2 / 78.6%, extensions to 2.618, and
the golden pocket shaded on the chart.

**Patterns** — trend structure, golden/death cross, bull and bear flags,
triangles and wedges, double tops and bottoms, base breakouts and breakdowns,
Bollinger squeezes, and inside-day / NR7 contraction. Each reports a confidence,
a trigger and an invalidation level. Thresholds are ATR-normalised, so they
behave the same on a $9 stock and a $900 one.

**Ranking** on the board is by day-trade setup grade, with the watch score
(proximity to a high-confluence level, an active pattern, compressed volatility,
elevated relative volume, a premarket gap) breaking ties.

## On the data

Everything shown is computed from real Yahoo Finance OHLCV bars. Nothing is
seeded, estimated or interpolated.

Two consequences worth knowing:

- Extended-hours feeds carry **stale-quote artifacts** — bars with zero volume
  whose high or low sits far outside the bar's own body, because the wick came
  from a spread rather than a trade. One of these invents a premarket high that
  never traded. They are **dropped**, and the report says how many, per symbol.
  They are not clamped, since trimming a wick would substitute a number the
  market never printed.
- The most recent few bars can never produce a swing pivot, because a fractal
  pivot needs bars on both sides to confirm it. That is a real limit of the
  method, not a gap being papered over.

Charts are drawn from 15-minute (desktop) or 30-minute (phone) aggregates of the
raw 5-minute bars purely for legibility. Every *measurement* runs on the raw
bars.

Earnings dates, float and short interest come from an endpoint that needs a
session token Yahoo hands out anonymously. When that handshake fails the report
says so per symbol and drops those fields rather than guessing; headlines and
every price measurement are unaffected.

Short interest is reported by exchanges on a settlement lag of roughly two
weeks, so "% of float short" describes a recent past, not this morning.

---

This is technical analysis output for your own research. It is not investment
advice and not a recommendation to buy or sell anything.
