/**
 * The one navigation bar every page carries, in the same place and the same
 * order: Prep, Stocks, Futures, Plan, Journal. Before it, each page had its own
 * set of link buttons in its own spot (and the futures page hid its links on
 * anything narrower than 1280px), so on a phone there was no way to tell how
 * to get from one page to another.
 *
 * Desktop: a slim bar across the top, brand on the left, tabs beside it.
 * Phone:   the same five tabs, full width, icon and label, still at the top,
 *          so it never collides with the trading controls the practice and
 *          futures pages keep at the bottom of the screen.
 *
 * Everything is prefixed `snav` so it can't collide with the pages' own CSS.
 */

export type NavPage = "prep" | "stocks" | "futures" | "plan" | "journal";

export interface NavHrefs {
  prep: string;
  stocks: string;
  futures: string;
  plan: string;
  journal: string;
}

export const DEFAULT_HREFS: NavHrefs = {
  prep: "index.html",
  stocks: "practice.html",
  futures: "futures.html",
  plan: "plan.html",
  journal: "journal.html",
};

const ICONS: Record<NavPage, string> = {
  // a clipboard with a checklist: the morning's research
  prep: `<path d="M9 4h6v3H9z"/><path d="M15 5.5h2.5a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1H9"/><path d="M8.5 11.5l1.2 1.2 2.3-2.4M13.5 11.5h2.5M8.5 16.5l1.2 1.2 2.3-2.4M13.5 16.5h2.5"/>`,
  // candlesticks: stock replay
  stocks: `<path d="M7 3v3M7 14v3M17 7v3M17 18v3"/><rect x="5" y="6" width="4" height="8" rx=".8"/><rect x="15" y="10" width="4" height="8" rx=".8"/>`,
  // a rising line with a marker: futures
  futures: `<path d="M3 19h18"/><path d="M4 15l4.5-4.5 3.5 3 7-7"/><path d="M15 6.5h4v4"/>`,
  // a shield with a check: the funded-account game plan
  plan: `<path d="M12 3.2l7 2.6v5.6c0 4.3-2.9 7.6-7 9.4-4.1-1.8-7-5.1-7-9.4V5.8z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>`,
  // a notebook: the journal
  journal: `<path d="M6 3.5h11.5a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M8.5 3.5v17M11.5 8h4.5M11.5 11.5h4.5"/>`,
};

const ITEMS: { id: NavPage; label: string; long: string; hint: string }[] = [
  { id: "prep", label: "Prep", long: "Today's Prep", hint: "Watchlist, levels and setups for today" },
  { id: "stocks", label: "Stocks", long: "Stock Practice", hint: "Replay a real stock day and trade it" },
  { id: "futures", label: "Futures", long: "Futures Practice", hint: "Replay NQ / ES futures on a funded-account ruleset" },
  { id: "plan", label: "Plan", long: "Game Plan", hint: "Turn posted levels into a stop, a size and a checklist for your funded account" },
  { id: "journal", label: "Journal", long: "Journal", hint: "Your trades and stats" },
];

export const SITE_NAV_CSS = `
.snav{display:flex;align-items:stretch;gap:2px;height:44px;padding:0 10px;flex:0 0 auto;
  background:#131722;border-bottom:1px solid #2a2e39;position:sticky;top:0;z-index:50;
  font:500 13px/1 -apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;
  -webkit-font-smoothing:antialiased;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);height:calc(44px + env(safe-area-inset-top,0px))}
.snav *{box-sizing:border-box}
.snav-brand{display:flex;align-items:center;gap:8px;padding:0 14px 0 4px;margin-right:6px;color:#f0f3fa;
  text-decoration:none;font-weight:600;font-size:14px;letter-spacing:.1px;border-right:1px solid #2a2e39;white-space:nowrap}
.snav-brand i{width:24px;height:24px;border-radius:6px;background:#2962ff;display:grid;place-content:center;
  color:#fff;font-weight:700;font-size:11px;line-height:1;font-style:normal;letter-spacing:0}
.snav-tabs{display:flex;align-items:stretch;gap:2px;min-width:0}
.snav a.snav-tab{display:flex;align-items:center;gap:7px;padding:0 12px;color:#9598a1;text-decoration:none;
  white-space:nowrap;position:relative;border-radius:0;transition:color .12s}
.snav a.snav-tab svg{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}
.snav a.snav-tab:hover{color:#f0f3fa;background:#1e222d}
.snav a.snav-tab[aria-current=page]{color:#f0f3fa}
.snav a.snav-tab[aria-current=page]::after{content:"";position:absolute;left:8px;right:8px;bottom:0;height:2px;
  border-radius:2px 2px 0 0;background:#2962ff}
.snav a.snav-tab[aria-current=page] svg{color:#5b8cff}
.snav-tab .s{display:none}
.snav-right{margin-left:auto;display:flex;align-items:center;gap:8px;color:#787b86;font-size:12px;white-space:nowrap}
@media (max-width:899px){
  .snav{padding-left:0;padding-right:0;height:calc(50px + env(safe-area-inset-top,0px))}
  .snav-brand,.snav-right{display:none}
  .snav-tabs{flex:1;gap:0}
  .snav a.snav-tab{flex:1;flex-direction:column;justify-content:center;gap:3px;padding:0 2px;font-size:11px}
  .snav a.snav-tab svg{width:20px;height:20px}
  .snav a.snav-tab:hover{background:transparent}
  .snav a.snav-tab[aria-current=page]::after{left:22%;right:22%}
  .snav-tab .l{display:none}
  .snav-tab .s{display:inline}
}
/* phone on its side: the chart needs the height more than the labels do */
@media (max-width:899px) and (orientation:landscape) and (max-height:520px){
  .snav{height:calc(36px + env(safe-area-inset-top,0px))}
  .snav a.snav-tab{flex-direction:row;gap:6px;font-size:12px}
  .snav a.snav-tab svg{width:16px;height:16px}
}
@media print{.snav{display:none}}
`;

/** The bar's markup. `hrefs` lets a page built into reports/ point at latest.html. */
export function siteNavHtml(active: NavPage, hrefs: Partial<NavHrefs> = {}, right = ""): string {
  const h = { ...DEFAULT_HREFS, ...hrefs };
  const tabs = ITEMS.map((it) => {
    const cur = it.id === active ? ` aria-current="page"` : "";
    return `<a class="snav-tab" href="${h[it.id]}"${cur} title="${it.hint}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[it.id]}</svg><span class="l">${it.long}</span><span class="s">${it.label}</span></a>`;
  }).join("");
  return `<nav class="snav" aria-label="Site"><a class="snav-brand" href="${h.prep}"><i>MP</i>Market Prep</a><div class="snav-tabs">${tabs}</div><div class="snav-right" id="snavRight">${right}</div></nav>`;
}

/** The bar with its stylesheet, ready to drop in as the first thing in <body>. */
export function siteNav(active: NavPage, hrefs: Partial<NavHrefs> = {}, right = ""): string {
  return `<style>${SITE_NAV_CSS}</style>${siteNavHtml(active, hrefs, right)}`;
}

/**
 * Puts the bar into a finished page. It replaces a `<!--SITE:NAV-->` marker
 * when the page has one (the futures page, which needs the bar inside its
 * full-height column), and otherwise goes straight after <body>. A page that
 * already carries the bar is left alone, so running this twice is harmless.
 */
export function injectSiteNav(html: string, active: NavPage, hrefs: Partial<NavHrefs> = {}): string {
  const nav = siteNav(active, hrefs);
  // A page built with an older bar (a report from before a tab was added) gets
  // the current one, so every page always shows the same tabs.
  const old = /<style>[^<]*?\.snav\{[\s\S]*?<\/style><nav class="snav"[\s\S]*?<\/nav>/;
  if (old.test(html)) return html.replace(old, () => nav);
  if (html.includes(`class="snav"`)) return html;
  if (html.includes("<!--SITE:NAV-->")) return html.replace("<!--SITE:NAV-->", nav);
  return html.replace(/<body[^>]*>/i, (m) => m + nav);
}
