/**
 * Fits how each ticker's options are priced, from the chains that were
 * recorded minute by minute (options/<SYM>/<DATE>.json), and files it for the
 * practice terminal.
 *
 *   node tools/fit-chains.mjs
 *
 * Days nobody recorded are priced by a model, so the model has to agree with
 * the days somebody did. tools/calibrate-vol.mjs measured that from a handful
 * of option trades on one day at a time, and the answer swung from 0.39 to 1.15
 * times the VIX between neighbouring days, so a day replayed on the wrong side
 * of one was priced at three times what the market charged. Here every minute
 * of every recorded day is used instead: the real bid and ask, out-of-the-money
 * only, an implied volatility backed out of each, and a smile fitted through
 * them across strikes. Per ticker, for contracts expiring tomorrow or later:
 *
 *   r1       the at-the-money level as a multiple of the index, in the variance
 *            units the page prices in (the measured intraday curve, so a 3pm
 *            contract and a 10am one are comparable)
 *   sk1, cv1 the smile: the volatility of a strike is the at-the-money level
 *            times (1 + sk z + cv z^2), z being how many standard deviations of
 *            the contract's own life the strike is from the price. A straight
 *            line prices the wings of a 0DTE a third to nine tenths too cheap,
 *            because the real smile curls up beyond about 1.5 sd
 *
 * and for a contract expiring today, which has far less behind it (a ticker's
 * full days of 0DTE quotes are a handful, and one ticker's 0DTE level fitted on
 * those alone swung by half between neighbouring days):
 *
 *   r0, sk0, cv0   the ticker's own 0DTE numbers, pulled toward the pooled
 *                  0DTE-to-later ratio of every ticker, harder the fewer
 *                  minutes the ticker has
 *   b0             r0 across the day. Against the variance the bars realise
 *                  the market charges a 0DTE less early and more late; that
 *                  shape is taken from all tickers together
 *
 * The level is then nudged until the model's prices, put through the page's own
 * formula, average out level with the recorded mids within 1.5 standard
 * deviations of the money: what is traded is a price, and price is not linear
 * in volatility. The tool finishes by pricing each recorded day from a fit made
 * without it, which is the error a day nobody recorded sees.
 *
 * Writes volatility/chainfit.json.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { indexFor } = await import(pathToFileURL(join(ROOT, "src", "volindex.ts")).href);

const MPD = 390, YEAR = 252 * MPD;

/* Which feed a minute may be fitted from. Yahoo's chain, read when Schwab was
   not signed in, is about ten times as jumpy minute to minute (the at-the-money
   volatility moves 0.3-0.5 points between recorded minutes against 0.03-0.04 on
   Schwab), and a fit through that noise would teach the page the noise. Those
   days are still replayed on their recorded quotes; they are just not measured. */
const TRUSTED = new Set(["schwab"]);
const N = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const bs = (S, K, s, T, type, r = 0.04) => { const sq = s * Math.sqrt(T), d1 = (Math.log(S / K) + (r + s * s / 2) * T) / sq, d2 = d1 - sq;
  return type === "call" ? S * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * N(-d1); };
const impliedVol = (S, K, p, T, type) => { let lo = 0.005, hi = 5;
  if (bs(S, K, hi, T, type) < p || bs(S, K, lo, T, type) > p) return null;
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; bs(S, K, m, T, type) > p ? hi = m : lo = m; } return lo; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const readJson = async (f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };

const intraday = await readJson(join(ROOT, "volatility", "intraday.json"));
const daily = (await readJson(join(ROOT, "volatility", "daily.json"))) ?? {};

/* The page's own variance clock (practice-app.html: ivarFor, varLeft, varAhead). */
function clock(sym) {
  const own = intraday?.symbols?.[sym];
  const rem = own?.rem ?? intraday?.rem ?? null;
  const gap = own?.overnight != null ? own.overnight : (intraday?.overnight ?? 0);
  const left = (m) => rem ? rem[Math.max(0, Math.min(MPD, Math.round(m)))] : Math.max(0, Math.min(1, (MPD - m) / MPD));
  return { ahead: (m, n) => left(m) + n * (1 + gap) };
}

async function indexAt(name, date, min) {
  const rec = await readJson(join(ROOT, "volatility", name, `${date}.json`));
  if (rec && Array.isArray(rec.m) && rec.m.length >= 380) return rec.m[Math.max(0, Math.min(rec.m.length - 1, Math.round(min) - 1))];
  return daily[name]?.[date]?.o ?? null;
}

function tradingDaysBetween(from, to) {
  const x = new Date(from + "T12:00:00Z"); let n = 0;
  while (x.toISOString().slice(0, 10) < to) { x.setUTCDate(x.getUTCDate() + 1); if (x.getUTCDay() % 6) n++; }
  return n;
}

/** Least squares y = a + b x (+ c x^2 when `quad`), by the normal equations. */
function poly(pts, quad) {
  const m = quad ? 3 : 2, A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  for (const [x, y] of pts) {
    const f = quad ? [1, x, x * x] : [1, x];
    for (let r = 0; r < m; r++) { for (let c = 0; c < m; c++) A[r][c] += f[r] * f[c]; A[r][m] += f[r] * y; }
  }
  for (let c = 0; c < m; c++) {                                  // Gauss-Jordan with a pivot
    let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < m; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let q = c; q <= m; q++) A[r][q] -= k * A[c][q]; }
  }
  const sol = A.map((row, r) => row[m] / row[r]);
  return { a: sol[0], b: sol[1], c: quad ? sol[2] : 0 };
}

/**
 * One minute of one expiry: the smile, as a line and (where the chain is wide
 * enough) as a parabola, or null. Out-of-the-money options only.
 */
function surface(spot, e, row, T) {
  const pts = [], spr = [];
  for (let k = 0; k < e.strikes.length; k++) {
    const K = e.strikes[k], x = Math.log(K / spot);
    // Every quote near the money, in or out of it, for how wide the market quotes.
    if (Math.abs(x) < 0.03) for (const t of ["call", "put"]) {
      const q = e[t][row]; if (!q) continue;
      const qb = q[k * 2] / 100, qa = q[k * 2 + 1] / 100;
      if (qb > 0 && qa > qb) spr.push([(qa + qb) / 2, qa - qb]);
    }
    const type = K >= spot ? "call" : "put";
    const l = e[type][row]; if (!l) continue;
    const b = l[k * 2] / 100, a = l[k * 2 + 1] / 100;
    if (!(b > 0 && a > b)) continue;
    const mid = (a + b) / 2;
    if (mid < 0.08 || a - b > Math.max(0.05, mid * 0.3)) continue;   // a tick's rounding is not a price
    const iv = impliedVol(spot, K, mid, T, type);
    if (iv == null) continue;
    pts.push([x, iv, mid, type === "call"]);
  }
  if (pts.length < 3) return null;
  const below = pts.filter((p) => p[0] < -0.0005).length, above = pts.filter((p) => p[0] > 0.0005).length;
  if (!below || !above) return null;                              // needs both sides of the money
  const lin = poly(pts, false);
  if (!lin || !(lin.a > 0.01 && lin.a < 3)) return null;
  const xs = pts.map((p) => p[0]), wide = Math.max(...xs) - Math.min(...xs);
  const q = pts.length >= 6 && below >= 2 && above >= 2 && wide > 0.004 ? poly(pts, true) : null;
  return { lin, quad: q && q.a > 0.01 && q.a < 3 ? q : null, pts: pts.map(([x, , m, c]) => [x, m, c]), spr };
}


const symbols = (await readdir(join(ROOT, "options"))).filter((s) => /^[A-Z.]+$/.test(s)).sort();
const out = { measuredAt: new Date().toISOString().slice(0, 10), symbols: {} };

const EDGES = [10, 60, 120, 180, 240, 300, 376];                // the 0DTE time-of-day windows
const CENTRES = EDGES.slice(0, -1).map((e, i) => Math.round((e + EDGES[i + 1]) / 2));
const SHRINK = Number(process.env.SHRINK) || 150;                                              // minutes of own 0DTE evidence worth as much as the pool
const med = (ss, k) => median(ss.map((x) => x[k]));
const level = (x, r) => r * (x.lv / 100) * Math.sqrt(x.va / (252 * x.T));

/** The mean log price error of the model against the recorded mids, within 1.5 sd of the money. */
function bias(grp, r, sk, cv, rKeep = r) {
  let sum = 0, cnt = 0;
  for (const x of grp) {
    const atm = level(x, r), sd = atm * Math.sqrt(x.T), sdKeep = level(x, rKeep) * Math.sqrt(x.T);
    for (const [lx, mid, isCall] of x.pts) {
      // Which strikes count is decided on the level the tuning started from, so
      // that it does not move as the level does.
      if (Math.abs(lx / sdKeep) > 1.5 || mid < 0.15) continue;
      const z = Math.max(-3.5, Math.min(3.5, lx / sd));
      const iv = Math.max(atm * 0.5, Math.min(atm * 3, atm * (1 + sk * z + cv * z * z)));
      const p = bs(x.spot, x.spot * Math.exp(lx), iv, x.T, isCall ? "call" : "put");
      if (p > 0) { sum += Math.log(p / mid); cnt++; }
    }
  }
  return cnt >= 20 ? sum / cnt : null;
}
/**
 * Bias rises with the level, so the level that zeroes it is found by bisection.
 * Stepping by the bias itself overshoots: a price moves about twice as fast as
 * the volatility it is computed from.
 */
function tune(grp, r, sk, cv) {
  if (bias(grp, r, sk, cv, r) == null) return null;
  let lo = r * 0.5, hi = r * 1.5;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2, b = bias(grp, mid, sk, cv, r);
    b > 0 ? (hi = mid) : (lo = mid);
  }
  return (lo + hi) / 2;
}

/* ---------------- the minutes that can be measured, per ticker ---------------- */
const data = {};
for (const sym of symbols) {
  const idx = indexFor(sym), ck = clock(sym);
  const files = (await readdir(join(ROOT, "options", sym))).filter((f) => f.endsWith(".json")).sort();
  const samples = [];
  for (const f of files) {
    const j = await readJson(join(ROOT, "options", sym, f));
    if (!j?.minutes?.length || !j.spot) continue;
    for (let row = 0; row < j.minutes.length; row++) {
      const min = j.minutes[row];
      if (min < 10 || min > 375 || min % 5) continue;           // the first and last minutes are not representative
      if (j.src && j.sources && !TRUSTED.has(j.sources[j.src[row]])) continue;
      const spot = j.spot[row] / 100; if (!(spot > 0)) continue;
      const lv = await indexAt(idx, j.date, min); if (!lv) continue;
      for (const e of j.expiries) {
        const n = tradingDaysBetween(j.date, e.date);
        if (n > 3 || e.date < j.date) continue;
        const T = (Math.max(0, MPD - min) + n * MPD) / YEAR;
        const s = surface(spot, e, row, T); if (!s) continue;
        const va = ck.ahead(min, n), at = (f) => f && ({
          r: Math.sqrt(f.a * f.a * T * 252 / va) / (lv / 100),
          sk: f.b * Math.sqrt(T),                               // slope per standard deviation, over the level
          cv: f.c * f.a * T,                                    // curvature, the same way
        });
        samples.push({ date: j.date, n, min, lin: at(s.lin), quad: at(s.quad), pts: s.pts, spr: s.spr, spot, T, va, lv });
      }
    }
  }
  if (samples.length < 150) { console.log(`${sym.padEnd(6)} ${samples.length} samples: too few, left to the old calibration`); continue; }
  // A ticker whose chains are wide enough for a parabola uses it throughout, so
  // that the level and the skew mean the same thing everywhere; the others keep
  // the line and no curvature.
  const useQuad = samples.filter((x) => x.quad).length >= 150;
  const use = (useQuad ? samples.filter((x) => x.quad) : samples).map((x) => ({ date: x.date, n: x.n, min: x.min, pts: x.pts, spr: x.spr, spot: x.spot, T: x.T, va: x.va, lv: x.lv, ...(useQuad ? x.quad : x.lin) }));
  if (use.filter((x) => x.n > 0).length < 100) { console.log(`${sym.padEnd(6)} too few minutes beyond 0DTE, left to the old calibration`); continue; }
  data[sym] = { idx, use, useQuad };
}

/* ---------------- the fit, optionally without one day ---------------- */
function fitAll(skipDate) {
  const own = {};
  for (const [sym, d] of Object.entries(data)) {
    const ss = d.use.filter((x) => x.date !== skipDate), l = ss.filter((x) => x.n > 0), z = ss.filter((x) => x.n === 0);
    if (l.length < 100) continue;
    const sk1 = med(l, "sk"), cv1 = med(l, "cv"), r1 = tune(l, med(l, "r"), sk1, cv1);
    if (r1 == null) continue;
    const o = { r1, sk1, cv1, n0: z.length, r0raw: null, sk0: sk1, cv0: cv1, mult: [] };
    if (z.length >= 20) {
      o.sk0 = med(z, "sk"); o.cv0 = med(z, "cv");
      o.r0raw = tune(z, med(z, "r"), o.sk0, o.cv0);
      if (o.r0raw != null) CENTRES.forEach((c, i) => {
        const w = z.filter((x) => x.min >= EDGES[i] && x.min < EDGES[i + 1]);
        const r = w.length >= 15 ? tune(w, med(w, "r"), o.sk0, o.cv0) : null;
        o.mult[i] = r != null ? r / o.r0raw : null;
      });
    }
    own[sym] = o;
  }
  // What every ticker's 0DTE has in common.
  const kPool = median(Object.values(own).filter((o) => o.r0raw != null && o.n0 >= 40).map((o) => o.r0raw / o.r1)) ?? 1.1;
  const shape = CENTRES.map((c, i) => median(Object.values(own).map((o) => o.mult[i]).filter((v) => v != null)) ?? 1);
  const P = {};
  for (const [sym, o] of Object.entries(own)) {
    const w = o.r0raw != null ? o.n0 / (o.n0 + SHRINK) : 0;
    const k0 = w * (o.r0raw != null ? o.r0raw / o.r1 : kPool) + (1 - w) * kPool;
    const r0 = o.r1 * k0, sk0 = w * o.sk0 + (1 - w) * o.sk1, cv0 = w * o.cv0 + (1 - w) * o.cv1;
    P[sym] = { r1: o.r1, sk1: o.sk1, cv1: o.cv1, r0, sk0, cv0, b0: CENTRES.map((c, i) => [c, r0 * shape[i], sk0, cv0]), n0: o.n0 };
  }
  return { P, kPool, shape };
}

/** The price error of one ticker's fit on a set of minutes, with the 0DTE level taken by time of day as the page does. */
function errOn(ss, p) {
  const z = ss.filter((x) => x.n === 0), l = ss.filter((x) => x.n > 0);
  let sum = 0, cnt = 0;
  CENTRES.forEach((c, i) => {
    const g = z.filter((x) => x.min >= EDGES[i] && x.min < EDGES[i + 1]), b = bias(g, p.b0[i][1], p.sk0, p.cv0);
    if (b != null) { sum += b * g.length; cnt += g.length; }
  });
  return { z: cnt ? sum / cnt : null, l: bias(l, p.r1, p.sk1, p.cv1) };
}

const { P, kPool, shape } = fitAll(null);
const dates = [...new Set(Object.values(data).flatMap((d) => d.use.map((x) => x.date)))].sort();
// Each day priced by a fit made without it, for every ticker at once.
const held = {};
for (const d of dates) {
  const { P: Q } = fitAll(d);
  for (const [sym, dd] of Object.entries(data)) {
    if (!Q[sym]) continue;
    const e = errOn(dd.use.filter((x) => x.date === d), Q[sym]);
    (held[sym] ??= []).push({ d, ...e });
  }
}

const fmt = (v) => (v == null ? "-" : (Math.expm1(v) * 100 >= 0 ? "+" : "") + (Math.expm1(v) * 100).toFixed(0) + "%");
const typical = (rows, k) => { const v = rows.map((x) => x[k]).filter((x) => x != null).map(Math.abs); return v.length ? fmt(median(v)) : "-"; };
const f4 = (v) => +v.toFixed(4);
/**
 * How wide the market quotes, by the price of the option: the median bid-ask
 * width in each band of mid price. A deep in-the-money option is quoted far
 * wider than one at the money, and a round trip pays it.
 */
function spreads(ss) {
  const EDGE = [0.1, 0.3, 0.75, 1.5, 3, 6, 12, 24, 48, 100, 1e9], rows = EDGE.slice(0, -1).map(() => []);
  for (const x of ss) for (const [m, w] of x.spr ?? []) { const b = EDGE.findIndex((e, i) => m >= e && m < EDGE[i + 1]); if (b >= 0) rows[b].push([m, w]); }
  const t = [];
  rows.forEach((r) => { if (r.length >= 30) t.push([f4(median(r.map((p) => p[0]))), f4(median(r.map((p) => p[1])))]); });
  return t;
}
console.log(`0DTE pooled: ${kPool.toFixed(2)}x the later-expiry level; across the day (windows centred ${CENTRES.join("/")}) ${shape.map((v) => v.toFixed(2)).join("/")}\n`);
for (const [sym, p] of Object.entries(P)) {
  const dd = data[sym];
  out.symbols[sym] = {
    index: dd.idx, r0: f4(p.r0), r1: f4(p.r1), sk0: f4(p.sk0), sk1: f4(p.sk1), cv0: f4(p.cv0), cv1: f4(p.cv1),
    b0: p.b0.map(([c, r, sk, cv]) => [c, f4(r), f4(sk), f4(cv)]),
    days: new Set(dd.use.map((x) => x.date)).size, samples: dd.use.length,
    sp: spreads(dd.use),
  };
  const h = held[sym] ?? [];
  console.log(`${sym.padEnd(6)} ${dd.idx}  r0=${p.r0.toFixed(3)} r1=${p.r1.toFixed(3)}  smile 0DTE sk=${p.sk0.toFixed(2)} cv=${p.cv0.toFixed(2)} later sk=${p.sk1.toFixed(2)} cv=${p.cv1.toFixed(2)}${dd.useQuad ? "" : " (line only)"}  ` +
    `${out.symbols[sym].days} days, ${dd.use.length} minutes (${p.n0} 0DTE)\n         a day held out of the fit, typical price error: 0DTE ${typical(h, "z")}, later ${typical(h, "l")}`);
}

{
  const all0 = Object.values(held).flat().map((x) => x.z).filter((x) => x != null).map(Math.abs), allL = Object.values(held).flat().map((x) => x.l).filter((x) => x != null).map(Math.abs);
  console.log(`
All tickers, every day held out: 0DTE typical ${fmt(median(all0))} (mean ${fmt(all0.reduce((a, b) => a + b, 0) / all0.length)}, n=${all0.length}); later typical ${fmt(median(allL))} (mean ${fmt(allL.reduce((a, b) => a + b, 0) / allL.length)}, n=${allL.length})`);
}
if (process.env.NOWRITE) process.exit(0);
await writeFile(join(ROOT, "volatility", "chainfit.json"), JSON.stringify(out, null, 1));
console.log(`\nWrote volatility/chainfit.json (${Object.keys(out.symbols).length} tickers).`);
