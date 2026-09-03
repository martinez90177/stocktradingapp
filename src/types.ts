/** A single OHLCV bar. `t` is epoch milliseconds (UTC). */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Yahoo's declared session boundaries for one trading day, epoch ms. */
export interface TradingPeriod {
  preStart: number;
  preEnd: number;
  regStart: number;
  regEnd: number;
  postStart: number;
  postEnd: number;
}

export interface Series {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  bars: Bar[];
  /** Present on intraday series only. */
  periods?: TradingPeriod[];
  meta: {
    regularMarketPrice: number;
    previousClose: number;
    fiftyTwoWeekHigh: number;
    fiftyTwoWeekLow: number;
    regularMarketVolume: number;
  };
}

/** A swing pivot: a local extreme in price. */
export interface Pivot {
  index: number;
  t: number;
  price: number;
  kind: "high" | "low";
  /** Half-width of the fractal window that confirmed it. Bigger = more significant. */
  strength: number;
}

/** One raw level candidate before clustering. */
export interface LevelSource {
  price: number;
  weight: number;
  method: string;
  label: string;
}

/** A clustered price level with confluence from multiple methods. */
export interface Level {
  price: number;
  low: number;
  high: number;
  score: number;
  methods: string[];
  labels: string[];
  side: "support" | "resistance" | "at-price";
  distancePct: number;
  distanceAtr: number;
}

export interface FibSet {
  label: string;
  direction: "up" | "down";
  anchorHigh: number;
  anchorLow: number;
  anchorHighT: number;
  anchorLowT: number;
  retracements: { ratio: number; price: number }[];
  extensions: { ratio: number; price: number }[];
  goldenPocket: { low: number; high: number };
}

export interface Pattern {
  name: string;
  direction: "bullish" | "bearish" | "neutral";
  /** 0-1. How well the price action matches the textbook shape. */
  confidence: number;
  status: "forming" | "triggered" | "recent";
  description: string;
  trigger?: number;
  invalidation?: number;
  /** Bar indices the pattern spans, for chart annotation. */
  from?: number;
  to?: number;
  /** Optional lines to draw: arrays of [barIndex, price]. */
  lines?: { points: [number, number][]; style: "solid" | "dashed" }[];
}

export interface IntradayContext {
  priorDay: { date: string; o: number; h: number; l: number; c: number; v: number } | null;
  premarket: { date: string; high: number; low: number; volume: number; last: number; bars: number } | null;
  openingRange: { minutes: number; high: number; low: number; date: string; pending: boolean } | null;
  sessionVwap: number | null;
  premarketVwap: number | null;
  gapPct: number | null;
  floorPivots: { pp: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number } | null;
}

/** A named candlestick shape, with what it conventionally indicates. */
export interface CandleSignal {
  name: string;
  /** How many sessions the shape spans. */
  bars: 1 | 2 | 3;
  direction: "bullish" | "bearish" | "neutral";
  meaning: string;
  /** Confirmation from range and volume, not just the shape. */
  reliability: "strong" | "moderate" | "weak";
}

/** What the last completed daily candle says about who was in control. */
export interface SessionRead {
  date: string;
  /** Close location value, -1 (closed on the low) to +1 (closed on the high). */
  clv: number;
  /** Body, upper wick and lower wick as fractions of the bar's range. */
  body: number;
  upperWick: number;
  lowerWick: number;
  rangeAtr: number;
  volRatio: number | null;
  changePct: number;
  green: boolean;
  closedAbovePriorHigh: boolean;
  closedBelowPriorLow: boolean;
  shapes: string[];
  signals: CandleSignal[];
  /** Geometry of the bar in plain language; present even with no named shape. */
  barDescription: string | null;
  /** The named shape if one fired, otherwise the bar description. */
  shapeSummary: string | null;
  /** Consecutive same-direction closes, e.g. "third straight higher close". */
  streak: string | null;
  pressure: "buyers" | "sellers" | "balanced";
  /** 0-1. How decisive the finish was. */
  strength: number;
  narrative: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TradeGrade {
  letter: string;
  total: number;
  components: { label: string; score: number; max: number; detail: string }[];
  bias: "long-side" | "short-side" | "two-sided" | "unclear";
  biasWhy: string;
}

export interface Fundamentals {
  earningsDates: number[];
  earningsIsEstimate: boolean;
  exDividendDate: number | null;
  floatShares: number | null;
  sharesOutstanding: number | null;
  sharesShort: number | null;
  sharesShortPriorMonth: number | null;
  shortPercentOfFloat: number | null;
  shortRatio: number | null;
  beta: number | null;
  marketCap: number | null;
  lastSplitFactor: string | null;
  lastSplitDate: number | null;
}

export interface NewsItem {
  title: string;
  publisher: string;
  link: string;
  published: number | null;
  ageHours: number | null;
  tags: { tag: string; lean: "bullish" | "bearish" | "neutral" }[];
  relatedTickers: string[];
  /** How specifically the story is about this symbol; higher ranks first. */
  relevance?: number;
}

export interface Catalysts {
  /** False when the authenticated endpoint could not be reached at all. */
  available: boolean;
  fundamentals: Fundamentals | null;
  news: NewsItem[];
  freshCount: number;
  nextEarnings: { date: number; inDays: number; estimated: boolean } | null;
  lastEarnings: { date: number; agoDays: number } | null;
  flags: { kind: string; tone: "warn" | "info"; label: string; detail: string }[];
  headlineLean: "bullish" | "bearish" | "mixed";
}

/** One contract from the chain, with the numbers that separate it from its neighbours. */
export interface OptionIdea {
  kind: "call" | "put";
  label: string;
  contractSymbol: string;
  strike: number;
  expiry: number;
  days: number;
  bid: number;
  ask: number;
  mid: number;
  spread: number | null;
  spreadPct: number | null;
  volume: number;
  openInterest: number;
  iv: number | null;
  inTheMoney: boolean;
  /** Where the underlying has to be at expiry to break even. */
  breakeven: number;
  moveNeededPct: number;
  /** What the stock typically covers over the contract's life, from ATR. */
  expectedMove: number | null;
  /** Move needed divided by expected move. Under 1 means the move fits. */
  moveRatio: number | null;
  /** Computed from implied volatility, not quoted by the exchange. */
  delta: number | null;
  targetLevel: number | null;
  liquidity: { tier: "good" | "fair" | "thin"; why: string };
}

export interface OptionsView {
  spot: number;
  atmIv: number | null;
  /** One-day move the option market is pricing, from at-the-money IV. */
  impliedDayMove: number | null;
  /** One-day move the stock has actually been making, from ATR. */
  atrDayMove: number | null;
  groups: { expiry: number; days: number; ideas: OptionIdea[] }[];
}

/** A discovered symbol from the movers scan, analysed more lightly. */
export interface Mover {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  relVolume: number | null;
  dollarVolume: number;
  marketCap: number | null;
  source: string[];
  rangePos52w: number | null;
  atrPct: number | null;
  session: SessionRead | null;
  catalysts: Catalysts | null;
  trend: string | null;
  lean: "long-side" | "short-side" | "unclear";
  leanWhy: string;
  score: number;
  bars: Bar[];
  errors: string[];
}

export interface Analysis {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  currency: string;
  daily: Series;
  intraday: Series | null;
  indicators: {
    sma20: number | null;
    sma50: number | null;
    sma200: number | null;
    ema9: number | null;
    ema21: number | null;
    atr14: number | null;
    atrPct: number | null;
    rsi14: number | null;
    bbWidthPct: number | null;
    bbSqueezeRank: number | null;
    relVolume: number | null;
    avgVol20: number | null;
    rangePos52w: number | null;
  };
  pivots: Pivot[];
  levels: Level[];
  fibs: FibSet[];
  patterns: Pattern[];
  volumeProfile: { bins: { price: number; volume: number }[]; poc: number; vah: number; val: number } | null;
  anchoredVwaps: { label: string; price: number; fromIndex: number; series: (number | null)[] }[];
  intradayContext: IntradayContext;
  session: SessionRead | null;
  catalysts: Catalysts | null;
  options: OptionsView | null;
  grade: TradeGrade;
  watchScore: number;
  headline: string;
  notes: string[];
  errors: string[];
}
