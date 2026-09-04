# Market Prep

Automated pre-market research for a stock watchlist. Every weekday morning it
measures your symbols and writes one self-contained HTML report with price
levels, Fibonacci, chart patterns and intraday reference levels — ready before
the open.

Runs on Node alone. **No `npm install`, no dependencies, no build step.**

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

## Putting it on GitHub

The folder is already a git repository with an initial commit; generated output
(`reports/`, `cache/`, `logs/`) is ignored, so only the 24 source files are
tracked. To push it:

```bash
git -C "C:/Users/GamerX/OneDrive/Market Prep" remote add origin https://github.com/<you>/market-prep.git
```

```bash
git -C "C:/Users/GamerX/OneDrive/Market Prep" push -u origin main
```

Create the repo on GitHub first (or install the `gh` CLI and use
`gh repo create market-prep --private --source=. --push`).

**Consider making it private.** `watchlist.json` holds the symbols you follow,
and the README describes how you trade. Nothing here contains credentials, but a
public repo publishes your setup.

One caveat about the `.git` folder living in OneDrive: sync and git can collide
if two machines write at once. It is fine for one machine at a time; if you work
from several, clone from GitHub to a local (non-synced) folder on each instead.

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
