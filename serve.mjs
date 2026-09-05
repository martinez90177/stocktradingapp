/**
 * Local viewer, and the live ticker lookup.
 *
 * The reports are self-contained files and open fine by double-clicking; this
 * exists so you can also pull them up from a phone or laptop on the same
 * network, and so any report gains a lookup box that analyses a ticker on
 * demand. The saved files stay clean and offline -- the lookup bar is injected
 * only into what this server hands out.
 *
 *   node serve.mjs [port]
 */
import { createServer } from "node:http";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSymbol } from "./src/pipeline.ts";
import { renderReport } from "./src/report.ts";
import { loadRules } from "./src/rules.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "reports");
const CACHE = join(HERE, "cache");
const PORT = Number(process.argv[2]) || 8099;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".js": "text/javascript",
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ *
 * Lookup bar
 * ------------------------------------------------------------------ */

const BAR = `
<style>
/* The bar floats over the page, so make room for it rather than covering the
   last rows of whatever is on screen. */
body{padding-bottom:82px}
#mpLookup{position:fixed;right:14px;bottom:14px;z-index:9999;display:flex;gap:6px;align-items:center;
  background:#111725;border:1px solid #2a3448;border-radius:10px;padding:7px 8px;
  box-shadow:0 6px 24px rgba(0,0,0,.45);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
#mpLookup input{width:110px;background:#0f1420;border:1px solid #2a3448;border-radius:6px;color:#e6eaf2;
  padding:6px 9px;font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
#mpLookup input:focus{outline:none;border-color:#3f7fff}
#mpLookup button{background:#3f7fff;border:0;border-radius:6px;color:#fff;padding:7px 12px;font-weight:650;cursor:pointer;font-size:12.5px}
#mpLookup button:disabled{opacity:.55;cursor:default}
#mpLookup a{color:#8b95a8;font-size:11.5px;text-decoration:none;padding:0 4px}
#mpLookup a:hover{color:#e6eaf2}
@media print{#mpLookup{display:none}}
</style>
<form id="mpLookup" action="/lookup" method="get" autocomplete="off">
  <input name="symbol" placeholder="TICKER" aria-label="ticker to look up" required>
  <button type="submit">Levels</button>
  <a href="/" title="latest report">latest</a>
  <a href="/archive" title="past reports">archive</a>
</form>
<script>
(function(){
  var f=document.getElementById("mpLookup");
  f.addEventListener("submit",function(){
    var b=f.querySelector("button");
    b.disabled=true; b.textContent="\\u2026";
  });
})();
</script>`;

/**
 * Injects the bar just before </body>, leaving the saved file untouched.
 *
 * The practice terminal is skipped: it has its own sticky action bar along the
 * bottom, and a floating lookup box sits on top of it.
 */
function withBar(html) {
  if (html.includes("Practice &middot; Market Prep") || html.includes("Practice · Market Prep")) return html;
  const i = html.lastIndexOf("</body>");
  return i === -1 ? html + BAR : html.slice(0, i) + BAR + html.slice(i);
}

function page(title, body) {
  return withBar(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{background:#0a0e17;color:#e6eaf2;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
max-width:640px;margin:40px auto;padding:0 20px}h1{font-size:18px}a{color:#3f7fff;text-decoration:none}
li{list-style:none}ul{padding:0}code{background:#111725;padding:2px 6px;border-radius:4px;font-size:13px}
.big{display:block;background:#111725;border:1px solid #1e2637;border-radius:10px;padding:14px;margin-bottom:22px;font-weight:600}
.err{border:1px solid rgba(239,83,80,.4);background:rgba(239,83,80,.08);border-radius:10px;padding:14px}</style>
${body}`);
}

async function listing() {
  const files = (await readdir(ROOT))
    .filter((f) => f.endsWith(".html") && f !== "latest.html")
    .sort()
    .reverse();
  const rows = files
    .map((f) => `<li><a href="/${encodeURIComponent(f)}">${esc(f.replace(".html", "").replace("_", "  "))}</a></li>`)
    .join("");
  return page(
    "Market Prep archive",
    `<h1>Market Prep</h1>
     <a class="big" href="/latest.html">Open the latest report &rarr;</a>
     <h2 style="font-size:13px;color:#8b95a8;text-transform:uppercase;letter-spacing:1px">Archive</h2>
     <ul>${rows || "<li>No reports yet. Run <code>node run.ts</code>.</li>"}</ul>`,
  );
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

// Short-lived memo so a refresh does not re-hit Yahoo for the same ticker.
const lookupCache = new Map();

async function handleLookup(url) {
  const raw = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  const symbols = raw.split(/[,\s]+/).filter(Boolean).slice(0, 5);
  if (symbols.length === 0) {
    return page("Lookup", `<h1>Lookup</h1><p>Type a ticker in the box, bottom right.</p>`);
  }

  const key = symbols.join(",");
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.html;

  const analyses = [];
  const failures = [];
  for (const symbol of symbols) {
    try {
      analyses.push(
        await analyzeSymbol(symbol, {
          cacheDir: CACHE, maxLevels: 9,
          dailyTtl: 600, intraTtl: 60, fundamentalsTtl: 6 * 3600, newsTtl: 600,
        }),
      );
    } catch (e) {
      failures.push({ symbol, reason: String(e.message || e).replace(`${symbol}: `, "") });
    }
  }

  if (analyses.length === 0) {
    return page(
      `Lookup: ${key}`,
      `<h1>Lookup</h1><div class="err"><b>${esc(key)}</b> could not be analyzed.<br>
       ${failures.map((f) => esc(f.reason)).join("<br>")}
       <p style="margin-bottom:0;color:#8b95a8;font-size:13px">Yahoo tickers: <code>BRK-B</code>, <code>^VIX</code>, <code>BTC-USD</code>, <code>ES=F</code>.</p></div>`,
    );
  }

  analyses.sort((a, b) => b.grade.total - a.grade.total);
  const html = withBar(
    renderReport({
      analyses, rules: await loadRules(join(HERE, "rules.json")).catch(() => null),
      movers: [], moversScanned: 0, moversNotes: [], failures,
      generatedAt: new Date(), lookbackDays: 180, intradayDays: 2,
      title: `Lookup: ${analyses.map((a) => a.symbol).join(", ")}`,
    }),
  );

  lookupCache.set(key, { at: Date.now(), html });
  // Keep a copy so it can be opened later without the server running.
  try {
    await mkdir(ROOT, { recursive: true });
    await writeFile(join(ROOT, `lookup-${key.replace(/[^A-Z0-9-]/gi, "")}.html`), html, "utf8");
  } catch {
    /* best effort */
  }
  return html;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/lookup") {
      const html = await handleLookup(url);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }

    if (url.pathname === "/") {
      const body = await readFile(join(ROOT, "latest.html"), "utf8").catch(() => null);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body ? withBar(body) : await listing());
      return;
    }

    if (url.pathname === "/archive") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await listing());
      return;
    }

    // Confine every file request to the reports directory.
    const target = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Not found", `<h1>Not found</h1><p><a href="/archive">Archive</a></p>`));
      return;
    }
    const ext = target.slice(target.lastIndexOf("."));
    const type = TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(ext === ".html" ? withBar(await readFile(target, "utf8")) : await readFile(target));
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => {
  console.log(`Market Prep viewer  ->  http://localhost:${PORT}`);
  console.log(`Ticker lookup       ->  http://localhost:${PORT}/lookup?symbol=TSLA`);
});
