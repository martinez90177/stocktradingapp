import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Catalysts, Fundamentals, NewsItem } from "./types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ *
 * Yahoo crumb session
 * ------------------------------------------------------------------ */

let session: { cookie: string; crumb: string; at: number } | null = null;

/**
 * The quoteSummary endpoint (earnings dates, float, short interest) rejects
 * anonymous calls with "Invalid Crumb". A visit to fc.yahoo.com sets the
 * consent cookies -- it answers 404, which is expected and fine, the cookies
 * are what matter -- and those cookies then buy a crumb token.
 */
async function getSession(): Promise<{ cookie: string; crumb: string } | null> {
  if (session && Date.now() - session.at < 30 * 60_000) return session;
  try {
    const r = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    const setCookie = r.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) return null;

    const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie },
      signal: AbortSignal.timeout(15_000),
    });
    const crumb = (await cr.text()).trim();
    if (!crumb || crumb.length > 32 || crumb.includes("<")) return null;

    session = { cookie, crumb, at: Date.now() };
    return session;
  } catch {
    return null;
  }
}

/**
 * GET a Yahoo endpoint that requires the crumb session, returning parsed JSON
 * or null. Shared so the options chain reuses one handshake.
 */
export async function authedJson(baseUrl: string): Promise<any | null> {
  const s = await getSession();
  if (!s) return null;
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}crumb=${encodeURIComponent(s.crumb)}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: s.cookie, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export { cached as cachedJson };

const val = (o: any): number | null => {
  const v = o && typeof o === "object" && "raw" in o ? o.raw : o;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

async function cached<T>(
  file: string | null,
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<T> {
  if (file && ttlSeconds > 0) {
    try {
      const w = JSON.parse(await readFile(file, "utf8"));
      if (Date.now() - w.at < ttlSeconds * 1000) return w.body as T;
    } catch {
      /* miss */
    }
  }
  const body = await produce();
  if (file) {
    try {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, JSON.stringify({ at: Date.now(), body }));
    } catch {
      /* cache write is best-effort */
    }
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * Fundamentals
 * ------------------------------------------------------------------ */

export async function fetchFundamentals(
  symbol: string,
  cacheDir: string | null,
  ttl = 6 * 3600,
): Promise<Fundamentals | null> {
  const safe = symbol.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const file = cacheDir ? join(cacheDir, `fund_${safe}.json`) : null;

  return cached<Fundamentals | null>(file, ttl, async () => {
    const s = await getSession();
    if (!s) return null;
    const modules = "calendarEvents,defaultKeyStatistics,summaryDetail";
    const url =
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${modules}&crumb=${encodeURIComponent(s.crumb)}`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Cookie: s.cookie },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const res = j?.quoteSummary?.result?.[0];
      if (!res) return null;

      const ce = res.calendarEvents ?? {};
      const ks = res.defaultKeyStatistics ?? {};
      const sd = res.summaryDetail ?? {};

      const dates: number[] = (ce.earnings?.earningsDate ?? [])
        .map((d: any) => val(d))
        .filter((n: number | null): n is number => n != null);

      const shares = val(ks.sharesShort);
      const priorShares = val(ks.sharesShortPriorMonth);

      return {
        earningsDates: dates.map((d) => d * 1000),
        earningsIsEstimate: ce.earnings?.isEarningsDateEstimate === true,
        exDividendDate: val(ce.exDividendDate) != null ? val(ce.exDividendDate)! * 1000 : null,
        floatShares: val(ks.floatShares),
        sharesOutstanding: val(ks.sharesOutstanding),
        sharesShort: shares,
        sharesShortPriorMonth: priorShares,
        shortPercentOfFloat: val(ks.shortPercentOfFloat),
        shortRatio: val(ks.shortRatio),
        beta: val(ks.beta) ?? val(sd.beta),
        marketCap: val(sd.marketCap),
        lastSplitFactor: typeof ks.lastSplitFactor === "string" ? ks.lastSplitFactor : null,
        lastSplitDate: val(ks.lastSplitDate) != null ? val(ks.lastSplitDate)! * 1000 : null,
      };
    } catch {
      return null;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Headline classification
 * ------------------------------------------------------------------ */

interface Rule {
  tag: string;
  lean: "bullish" | "bearish" | "neutral";
  re: RegExp;
}

/**
 * Categorises a headline by keyword.
 *
 * This is deliberately category detection, not sentiment scoring. A lean is
 * attached only where the wording itself is unambiguous -- "downgrades" or
 * "prices offering" mean one thing regardless of context, while "earnings" on
 * its own means nothing directional. The headline is always shown next to the
 * tag so the call can be checked rather than trusted.
 */
const RULES: Rule[] = [
  { tag: "Upgrade", lean: "bullish", re: /\b(upgrade[sd]?|raises? (?:price )?target|initiate[sd]? .{0,20}buy|outperform|overweight)\b/i },
  { tag: "Downgrade", lean: "bearish", re: /\b(downgrade[sd]?|cuts? (?:price )?target|lowers? target|underperform|underweight|sell rating)\b/i },
  { tag: "Beat", lean: "bullish", re: /\b(beats?|tops?|surpass(?:es|ed)?|record (?:revenue|quarter|profit)|raises? (?:guidance|outlook|forecast))\b/i },
  { tag: "Miss", lean: "bearish", re: /\b(miss(?:es|ed)?|falls? short|cuts? (?:guidance|outlook|forecast)|lowers? (?:guidance|outlook)|warns?|profit warning)\b/i },
  { tag: "Earnings", lean: "neutral", re: /\b(earnings|quarterly results|q[1-4] (?:results|report)|reports? (?:first|second|third|fourth) quarter)\b/i },
  { tag: "M&A", lean: "bullish", re: /\b(acquir\w+|merger|buyout|takeover|to buy|acquisition of|stake in)\b/i },
  { tag: "Share offering", lean: "bearish", re: /\b(offering|dilut\w+|convertible notes|registered direct|at-the-market|secondary offering|prices? \$?\d+.{0,12}(?:million|billion) )\b/i },
  { tag: "Buyback", lean: "bullish", re: /\b(buyback|repurchase|share repurchase|increases? dividend|special dividend)\b/i },
  { tag: "Clinical / FDA", lean: "neutral", re: /\b(fda|phase [123]|clinical trial|approval|breakthrough therapy|topline (?:data|results))\b/i },
  { tag: "Legal risk", lean: "bearish", re: /\b(lawsuit|sued|investigation|probe|subpoena|fraud|sec charges|class action|settlement)\b/i },
  { tag: "Short report", lean: "bearish", re: /\b(short seller|short report|hindenburg|muddy waters|citron)\b/i },
  { tag: "Restructuring", lean: "bearish", re: /\b(layoffs?|job cuts|restructur\w+|closes? plants?|workforce reduction)\b/i },
  { tag: "Management", lean: "neutral", re: /\b(ceo|cfo|steps? down|resign\w*|appoint\w*|names? new)\b/i },
  { tag: "Contract win", lean: "bullish", re: /\b(wins? (?:contract|deal|order)|awarded|partnership with|selects?|signs? (?:deal|agreement))\b/i },
  { tag: "Distress", lean: "bearish", re: /\b(bankrupt\w*|chapter 11|delisting|going concern|default)\b/i },
  { tag: "Split", lean: "neutral", re: /\b(stock split|reverse split)\b/i },
  { tag: "Index change", lean: "bullish", re: /\b(join(?:s|ing)? the s&p|added to (?:the )?(?:s&p|nasdaq-100|russell)|index inclusion)\b/i },
];

export function classifyHeadline(title: string): { tag: string; lean: Rule["lean"] }[] {
  const out: { tag: string; lean: Rule["lean"] }[] = [];
  for (const r of RULES) {
    if (r.re.test(title)) out.push({ tag: r.tag, lean: r.lean });
    if (out.length >= 3) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * News
 * ------------------------------------------------------------------ */

/**
 * How specifically a story is about this symbol.
 *
 * Yahoo's search happily returns market wraps like "Dow Jones Futures: Stocks
 * Jump..." for any ticker, and those are noise before an open. Stories that
 * name the ticker or the company are ranked above them.
 */
function relevance(n: NewsItem, symbol: string, name: string): number {
  let score = 0;
  if (n.relatedTickers.some((t) => String(t).toUpperCase() === symbol)) score += 4;
  if (new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(n.title)) score += 3;

  // Match the distinctive part of the company name, skipping corporate suffixes.
  const word = name
    .replace(/\b(inc|corp|corporation|company|co|ltd|plc|holdings|group|technologies|technology|the)\b\.?/gi, "")
    .trim()
    .split(/[\s,]+/)[0];
  if (word && word.length >= 4 && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(n.title)) {
    score += 3;
  }
  if (n.relatedTickers.length > 6) score -= 1; // broad round-ups
  return score;
}

export async function fetchNews(
  symbol: string,
  cacheDir: string | null,
  ttl = 900,
  count = 8,
  companyName = "",
): Promise<NewsItem[]> {
  const safe = symbol.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const file = cacheDir ? join(cacheDir, `news_${safe}.json`) : null;

  return cached<NewsItem[]>(file, ttl, async () => {
    const url =
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}` +
      `&newsCount=${count}&quotesCount=0&enableFuzzyQuery=false`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return [];
      const j = await r.json();
      const items: NewsItem[] = [];
      for (const n of j?.news ?? []) {
        if (typeof n?.title !== "string") continue;
        const ts = typeof n.providerPublishTime === "number" ? n.providerPublishTime * 1000 : null;
        items.push({
          title: n.title,
          publisher: typeof n.publisher === "string" ? n.publisher : "",
          link: typeof n.link === "string" ? n.link : "",
          published: ts,
          ageHours: ts ? (Date.now() - ts) / 3_600_000 : null,
          tags: classifyHeadline(n.title),
          relatedTickers: Array.isArray(n.relatedTickers) ? n.relatedTickers.slice(0, 6) : [],
        });
      }
      // Symbol-specific first, then newest. Recency alone floats generic
      // market wraps to the top, which is the least useful thing on the card.
      for (const it of items) it.relevance = relevance(it, symbol.toUpperCase(), companyName);
      return items.sort(
        (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || (b.published ?? 0) - (a.published ?? 0),
      );
    } catch {
      return [];
    }
  });
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;

/** Whole calendar days from today (ET) to the given instant. */
function daysFromToday(t: number): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const today = Date.parse(fmt.format(new Date()) + "T00:00:00Z");
  const then = Date.parse(fmt.format(new Date(t)) + "T00:00:00Z");
  return Math.round((then - today) / DAY);
}

export function buildCatalysts(
  fundamentals: Fundamentals | null,
  news: NewsItem[],
  fundamentalsAvailable: boolean,
): Catalysts {
  const flags: Catalysts["flags"] = [];
  let nextEarnings: Catalysts["nextEarnings"] = null;
  let lastEarnings: Catalysts["lastEarnings"] = null;

  if (fundamentals) {
    for (const t of fundamentals.earningsDates) {
      const d = daysFromToday(t);
      if (d >= 0 && (nextEarnings == null || d < nextEarnings.inDays)) {
        nextEarnings = { date: t, inDays: d, estimated: fundamentals.earningsIsEstimate };
      }
      // Keep the most recent past date: the smallest number of days ago.
      if (d < 0 && (lastEarnings == null || -d < lastEarnings.agoDays)) {
        lastEarnings = { date: t, agoDays: -d };
      }
    }

    if (nextEarnings) {
      if (nextEarnings.inDays <= 1) {
        flags.push({
          kind: "earnings",
          tone: "warn",
          label: nextEarnings.inDays === 0 ? "Earnings today" : "Earnings tomorrow",
          detail: `Chart levels carry much less weight through an earnings gap${nextEarnings.estimated ? "; Yahoo lists this date as estimated" : ""}.`,
        });
      } else if (nextEarnings.inDays <= 7) {
        flags.push({
          kind: "earnings",
          tone: "warn",
          label: `Earnings in ${nextEarnings.inDays} days`,
          detail: `Reported ${new Date(nextEarnings.date).toISOString().slice(0, 10)}${nextEarnings.estimated ? " (estimated date)" : ""}. Multi-day setups run into the event.`,
        });
      }
    }
    if (lastEarnings && lastEarnings.agoDays <= 3) {
      flags.push({
        kind: "earnings",
        tone: "info",
        label: `Reported ${lastEarnings.agoDays === 0 ? "today" : `${lastEarnings.agoDays}d ago`}`,
        detail: "Recent results usually explain an outsized move and elevated volume.",
      });
    }

    const spf = fundamentals.shortPercentOfFloat;
    if (spf != null && spf >= 0.1) {
      const trend =
        fundamentals.sharesShort != null && fundamentals.sharesShortPriorMonth != null
          ? fundamentals.sharesShort > fundamentals.sharesShortPriorMonth ? "rising" : "falling"
          : null;
      flags.push({
        kind: "short",
        tone: spf >= 0.2 ? "warn" : "info",
        label: `${(spf * 100).toFixed(1)}% of float short`,
        detail: `${fundamentals.shortRatio != null ? `${fundamentals.shortRatio.toFixed(1)} days to cover. ` : ""}${trend ? `Short interest ${trend} month over month. ` : ""}Crowded shorts make upside moves faster and more violent.`,
      });
    }

    const fl = fundamentals.floatShares;
    if (fl != null && fl > 0 && fl < 50e6) {
      flags.push({
        kind: "float",
        tone: "warn",
        label: `Low float (${(fl / 1e6).toFixed(1)}M shares)`,
        detail: "A small float moves further on the same order flow, in both directions.",
      });
    }

    if (fundamentals.exDividendDate != null) {
      const d = daysFromToday(fundamentals.exDividendDate);
      if (d >= 0 && d <= 3) {
        flags.push({
          kind: "dividend",
          tone: "info",
          label: d === 0 ? "Ex-dividend today" : `Ex-dividend in ${d}d`,
          detail: "Price is marked down by the dividend on the ex-date, which is not a real decline.",
        });
      }
    }

    if (fundamentals.beta != null && fundamentals.beta >= 2) {
      flags.push({
        kind: "beta",
        tone: "info",
        label: `Beta ${fundamentals.beta.toFixed(2)}`,
        detail: "Moves roughly twice the market, so index direction dominates its day.",
      });
    }
  }

  // Fresh news counts for far more than week-old news before an open.
  const fresh = news.filter((n) => n.ageHours != null && n.ageHours <= 24);
  const leanCounts = { bullish: 0, bearish: 0 };
  for (const n of fresh) {
    for (const t of n.tags) {
      if (t.lean === "bullish") leanCounts.bullish++;
      if (t.lean === "bearish") leanCounts.bearish++;
    }
  }
  const headlineLean: Catalysts["headlineLean"] =
    leanCounts.bullish > leanCounts.bearish ? "bullish"
    : leanCounts.bearish > leanCounts.bullish ? "bearish"
    : "mixed";

  if (fresh.length > 0) {
    const tags = [...new Set(fresh.flatMap((n) => n.tags.map((t) => t.tag)))];
    if (tags.length > 0) {
      flags.push({
        kind: "news",
        tone: "info",
        label: `${fresh.length} headline${fresh.length === 1 ? "" : "s"} in 24h`,
        detail: tags.join(", "),
      });
    }
  }

  return {
    available: fundamentalsAvailable,
    fundamentals,
    news,
    freshCount: fresh.length,
    nextEarnings,
    lastEarnings,
    flags,
    headlineLean,
  };
}
