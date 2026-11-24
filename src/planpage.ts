/**
 * Game Plan: turns a levels post (Over X --> T1 --> T2 / Under Y --> T1 --> T2)
 * into what a funded futures account needs before the first click:
 *
 *   - SPY levels converted to MES at today's price ratio
 *   - the stop at the opposite level, never tighter than a normal 5-minute swing
 *   - dollars at risk, contracts allowed by the per-trade limit, the win rate
 *     needed to break even, and a plain Take / Careful / Skip
 *   - the data-release start time, a pre-entry checklist, and a daily stop
 *     (losses and P&L today against the limits)
 *   - a button that draws the levels on the Futures practice chart
 *
 * Everything runs in the browser and is kept in localStorage; the account rules
 * are read from the Futures practice settings so they are set in one place.
 * The build only supplies two measured facts: the latest SPY -> MES ratio and how
 * far MES / MNQ normally swing in the first 90 minutes.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { siteNav } from "./sitenav.ts";

export interface Noise { m1: number; m5: number; m5hi: number; days: number }
export interface PlanData {
  ratio: { spy: number; mes: number; date: string; time: string } | null;
  noise: Record<string, Noise>;
}

type Bar = number[]; // [t, o, h, l, c, v]

const NY_HM = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const hmOf = (t: number) => NY_HM.format(new Date(t * 1000));
const dateOf = (t: number) => NY_DATE.format(new Date(t * 1000));

const quantile = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(p * (s.length - 1))] ?? 0;
};

async function dayFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
}

async function bars(file: string): Promise<Bar[]> {
  try { return (JSON.parse(await readFile(file, "utf8")).bars ?? []) as Bar[]; } catch { return []; }
}

/** How far a contract normally moves from 9:30 to 11:00 ET, over the last 15 recorded days. */
async function measureNoise(futDir: string, sym: string): Promise<Noise | null> {
  const files = (await dayFiles(join(futDir, sym))).slice(-15);
  const r1: number[] = [], r5: number[] = [];
  let days = 0;
  for (const f of files) {
    const d = f.slice(0, 10);
    const b = (await bars(join(futDir, sym, f))).filter((x) => {
      const hm = hmOf(x[0]);
      return dateOf(x[0]) === d && hm >= "09:30" && hm < "11:00";
    });
    if (b.length < 60) continue;
    days++;
    for (const x of b) r1.push(x[2] - x[3]);
    for (let i = 0; i + 5 <= b.length; i += 5) {
      const g = b.slice(i, i + 5);
      r5.push(Math.max(...g.map((x) => x[2])) - Math.min(...g.map((x) => x[3])));
    }
  }
  if (!days) return null;
  return { m1: quantile(r1, 0.5), m5: quantile(r5, 0.5), m5hi: quantile(r5, 0.9), days };
}

/** The SPY -> MES ratio at the last minute both were recorded (SPY bars are regular hours, one a minute from 9:30). */
async function latestRatio(sessDir: string, futDir: string): Promise<PlanData["ratio"]> {
  const spyDays = new Set(await dayFiles(join(sessDir, "SPY")));
  const mesDays = (await dayFiles(join(futDir, "MES"))).filter((f) => spyDays.has(f)).reverse();
  for (const f of mesDays) {
    const d = f.slice(0, 10);
    let spy: number[][] = [];
    try { spy = JSON.parse(await readFile(join(sessDir, "SPY", f), "utf8")).bars ?? []; } catch { continue; }
    const mes = new Map<string, Bar>();
    for (const b of await bars(join(futDir, "MES", f))) if (dateOf(b[0]) === d) mes.set(hmOf(b[0]), b);
    for (let i = spy.length - 1; i >= 0; i--) {
      const m = 570 + i;
      const hm = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
      const mb = mes.get(hm);
      const sc = spy[i]?.[3];
      if (mb && sc > 0) return { spy: sc, mes: mb[4], date: d, time: hm };
    }
  }
  return null;
}

export async function loadPlanData(root: string): Promise<PlanData> {
  const futDir = join(root, "futures");
  const noise: Record<string, Noise> = {};
  for (const s of ["MES", "MNQ"]) {
    const n = await measureNoise(futDir, s);
    if (n) noise[s] = n;
  }
  return { ratio: await latestRatio(join(root, "sessions"), futDir), noise };
}

export function renderPlan(data: PlanData, reportHref = "index.html"): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#131722">
<title>Game Plan &middot; Market Prep</title>
<style>${CSS}</style>
</head><body>
${siteNav("plan", { prep: reportHref })}
<main class="wrap">
  <header class="top">
    <h1>Game Plan</h1>
    <p>Paste the levels. Get the stop, the size and a yes or no before you click.</p>
  </header>

  <div id="dayBanner" class="banner" hidden></div>

  <section class="card" aria-labelledby="hToday">
    <h2 id="hToday">Today</h2>
    <div class="daygrid">
      <div class="stat"><span>Losses</span><b id="lossTxt">0 / 2</b>
        <div class="step"><button type="button" id="lossMinus" aria-label="One fewer loss">&minus;</button><button type="button" id="lossPlus" aria-label="Log a loss">+</button></div></div>
      <div class="stat"><span>P&amp;L today ($)</span>
        <input id="pnl" type="text" inputmode="decimal" placeholder="0" autocomplete="off" aria-label="Profit or loss today in dollars">
        <small id="pnlLeft"></small></div>
    </div>
    <label class="field">Data release, his time (PST)
      <div class="row2"><input id="dataPst" type="time" aria-label="Data release time in Pacific time"><button type="button" class="ghost" id="noData">No data today</button></div>
    </label>
    <p class="hint" id="dataEt">Check his #week-in-advance post. His times are Pacific; this shows the Eastern time.</p>
  </section>

  <section class="card" aria-labelledby="hPaste">
    <h2 id="hPaste">Paste the levels</h2>
    <label class="field" for="post">His post, word for word</label>
    <textarea id="post" rows="4" placeholder="Over 715.77 --> 716.41 --> 717.52&#10;Under 713.5 --> 712.4 --> 710.71" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
    <div class="field">Levels are for
      <div class="seg" role="group" aria-label="Levels are for" id="srcSeg">
        <button type="button" data-v="SPY">SPY</button><button type="button" data-v="MES">MES</button><button type="button" data-v="MNQ">MNQ</button>
      </div>
    </div>
    <div class="field">You trade
      <div class="seg" role="group" aria-label="You trade" id="tradeSeg">
        <button type="button" data-v="MES">MES</button><button type="button" data-v="MNQ">MNQ</button>
      </div>
    </div>
    <div id="convBox" hidden>
      <div class="row2 prices">
        <label class="field">SPY price now<input id="spyPx" type="text" inputmode="decimal" autocomplete="off"></label>
        <label class="field">MES price now<input id="mesPx" type="text" inputmode="decimal" autocomplete="off"></label>
      </div>
      <p class="hint" id="ratioTxt"></p>
    </div>
    <p class="msg" id="convMsg" hidden></p>
  </section>

  <section aria-labelledby="hPlan">
    <h2 class="sec" id="hPlan">The plan</h2>
    <p class="empty" id="planEmpty">Paste his post above and the plan appears here.</p>
    <div id="sides"></div>
    <div id="sendRow" hidden>
      <button type="button" class="primary" id="sendBtn">Draw these on the Futures practice chart</button>
      <p class="hint" id="sendMsg"></p>
    </div>
  </section>

  <section class="card" aria-labelledby="hCheck">
    <h2 id="hCheck">Before you click</h2>
    <ul class="checks" id="checks"></ul>
  </section>

  <details class="card" id="acctBox">
    <summary><h2>Your account</h2><span id="acctSum"></span></summary>
    <p class="hint" id="acctFrom"></p>
    <div class="form">
      <label class="field">Trailing drawdown ($)<input id="cDd" type="text" inputmode="decimal" autocomplete="off"></label>
      <label class="field">Daily loss limit ($)<input id="cDaily" type="text" inputmode="decimal" autocomplete="off"></label>
      <label class="field">Most you'll risk per trade ($)<input id="cRisk" type="text" inputmode="decimal" autocomplete="off"></label>
      <label class="field">Stop trading after this many losses<input id="cLoss" type="text" inputmode="numeric" autocomplete="off"></label>
      <label class="field">Safety buffer (points)<input id="cBuf" type="text" inputmode="decimal" autocomplete="off"></label>
      <label class="field">Smallest stop (points, blank = auto)<input id="cMin" type="text" inputmode="decimal" autocomplete="off"></label>
    </div>
    <p class="hint">Blank fields use the default shown in grey. The safety buffer moves entries further out and targets closer in.</p>
    <button type="button" class="ghost" id="cReset">Back to defaults</button>
  </details>

  <section class="card facts" aria-labelledby="hWhy">
    <h2 id="hWhy">Why these numbers</h2>
    <div id="noiseTbl"></div>
    <ul class="why">
      <li><b>Stop at his opposite level.</b> If price gets all the way to his other side, his idea is wrong.</li>
      <li><b>Never tighter than a normal 5-minute swing.</b> A tighter stop gets hit by noise even when the idea is right.</li>
      <li><b>Size comes from the stop.</b> Contracts = what you'll risk &divide; risk per contract, rounded down. If one contract is too much, skip.</li>
      <li><b>Break-even win rate</b> is how often a trade must win just to not lose money. Above 60% is hard to keep up.</li>
    </ul>
  </section>
</main>
<script>
var DATA=${json};
${JS}
</script>
</body></html>`;
}

const CSS = `
:root{--bg:#131722;--panel:#1e222d;--line:#2a2e39;--line2:#363a45;--text:#d1d4dc;--hi:#f0f3fa;--dim:#9598a1;--dim2:#787b86;
  --up:#22ab94;--down:#f7525f;--warn:#ff9800;--accent:#2962ff;
  --sans:-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;padding-bottom:calc(32px + env(safe-area-inset-bottom,0px));overflow-x:hidden}
.wrap{max-width:760px;margin:0 auto;padding:0 max(14px,env(safe-area-inset-left,0px)) 0 max(14px,env(safe-area-inset-right,0px))}
header.top{padding:20px 0 6px}
header.top h1{margin:0;font-size:26px;line-height:1.15;color:var(--hi);letter-spacing:-.5px}
header.top p{margin:6px 0 0;color:var(--dim);font-size:14px}
h2{margin:0 0 12px;font-size:16px;color:var(--hi);font-weight:650}
h2.sec{font-size:12px;text-transform:uppercase;letter-spacing:1.1px;color:var(--dim2);margin:22px 0 10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin-top:14px}
.field{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dim);margin-top:12px}
.hint{font-size:13px;color:var(--dim2);margin:8px 0 0;line-height:1.5}
.empty{color:var(--dim2);font-size:14px;margin:0}
input,textarea{font:16px/1.3 var(--sans);color:var(--hi);background:var(--bg);border:1px solid var(--line2);border-radius:6px;
  padding:11px 12px;width:100%;min-height:46px;-webkit-appearance:none;appearance:none;font-variant-numeric:tabular-nums}
textarea{resize:vertical;min-height:96px;line-height:1.45}
input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
input[type=time]{color-scheme:dark}
button{font:600 15px var(--sans);border-radius:6px;cursor:pointer;min-height:46px;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
button.primary{width:100%;background:var(--accent);color:#fff;border:0;padding:12px 16px}
button.primary:active{background:#1e53e5}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line2);padding:10px 14px;white-space:nowrap}
button.ghost:active{background:var(--line)}
.row2{display:flex;gap:10px;align-items:stretch}
.row2>*{flex:1;min-width:0}
.row2>button{flex:0 0 auto}
.prices .field{margin-top:12px}
.seg{display:flex;background:var(--bg);border:1px solid var(--line2);border-radius:8px;padding:3px;gap:3px}
.seg button{flex:1;background:transparent;border:0;color:var(--dim);min-height:42px;border-radius:5px;font-size:15px}
.seg button[aria-pressed=true]{background:var(--accent);color:#fff}
.msg{margin:12px 0 0;padding:10px 12px;border-radius:6px;background:rgba(255,152,0,.12);color:#ffb74d;font-size:14px}
.banner{margin-top:14px;padding:14px 16px;border-radius:8px;font-weight:600;font-size:15px;line-height:1.4}
.banner.stop{background:rgba(247,82,95,.16);border:1px solid rgba(247,82,95,.5);color:#ff8a93}
.banner.wait{background:rgba(255,152,0,.12);border:1px solid rgba(255,152,0,.45);color:#ffb74d}
.banner.go{background:rgba(34,171,148,.12);border:1px solid rgba(34,171,148,.45);color:#4fd1b8}
.daygrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.stat>span{font-size:12px;color:var(--dim2)}
.stat>b{font-size:22px;color:var(--hi);line-height:1.1}
.stat small{font-size:12px;color:var(--dim2)}
.stat input{min-height:42px;padding:8px 10px;font-size:18px}
.step{display:flex;gap:6px}
.step button{flex:1;background:var(--panel);border:1px solid var(--line2);color:var(--hi);font-size:20px;min-height:42px;padding:0}
.step button:active{background:var(--line)}
#sides{display:grid;gap:14px}
.side{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--line2);border-radius:8px;padding:14px 16px}
.side.long{border-left-color:var(--up)}.side.short{border-left-color:var(--down)}
.sideh{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sideh h3{margin:0;font-size:17px;color:var(--hi);flex:1 1 auto;min-width:0}
.sideh h3 small{display:block;font-size:13px;color:var(--dim2);font-weight:400;margin-top:2px}
.pill{font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px;white-space:nowrap}
.pill.take{background:rgba(34,171,148,.18);color:#4fd1b8}
.pill.careful{background:rgba(255,152,0,.16);color:#ffb74d}
.pill.skip,.pill.off{background:rgba(247,82,95,.16);color:#ff8a93}
.nums{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:12px}
.nums div{background:var(--bg);padding:9px 11px;min-width:0}
.nums span{display:block;font-size:12px;color:var(--dim2)}
.nums b{display:block;font-size:17px;color:var(--hi);font-weight:600;overflow-wrap:anywhere}
.nums i{display:block;font-style:normal;font-size:12px;color:var(--dim2);overflow-wrap:anywhere}
.nums .entry b{color:#5b8cff}.nums .stop b{color:var(--warn)}.nums .tgt b{color:var(--up)}
.reasons{margin:12px 0 0;padding:0;list-style:none;display:grid;gap:6px}
.reasons li{font-size:14px;line-height:1.45;padding-left:20px;position:relative;color:var(--text)}
.reasons li::before{content:"";position:absolute;left:4px;top:.55em;width:7px;height:7px;border-radius:50%;background:var(--dim2)}
.reasons li.bad::before{background:var(--down)}.reasons li.warn::before{background:var(--warn)}.reasons li.ok::before{background:var(--up)}
#sendRow{margin-top:14px}
.hint a.go{display:inline-block;color:#5b8cff;font-weight:600;padding:10px 0;text-decoration:none}
.checks{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.checks label{display:flex;gap:12px;align-items:flex-start;padding:10px 4px;cursor:pointer;font-size:15px;line-height:1.4;min-height:46px}
.checks input{width:22px;height:22px;min-height:0;flex:0 0 22px;margin:0;padding:0;accent-color:var(--accent);-webkit-appearance:checkbox;appearance:auto}
.checks input:checked+span{color:var(--dim2);text-decoration:line-through}
details.card summary{list-style:none;display:flex;align-items:center;gap:10px;cursor:pointer;min-height:44px;margin:-6px 0;-webkit-tap-highlight-color:transparent}
details.card summary::-webkit-details-marker{display:none}
details.card summary h2{margin:0;flex:0 0 auto}
details.card summary span{flex:1;text-align:right;font-size:13px;color:var(--dim2);min-width:0}
details.card summary::after{content:"";width:9px;height:9px;border-right:2px solid var(--dim2);border-bottom:2px solid var(--dim2);transform:rotate(45deg);margin:-4px 4px 0 0;flex:0 0 auto}
details[open].card summary::after{transform:rotate(225deg);margin-top:4px}
.form{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
input::placeholder,textarea::placeholder{color:#5d606b}
#cReset{margin-top:14px}
.facts table{width:100%;border-collapse:collapse;font-size:14px}
.facts th{text-align:left;font-weight:600;color:var(--dim2);font-size:12px;padding:0 6px 6px 0}
.facts td{padding:7px 6px 7px 0;border-top:1px solid var(--line)}
.facts td:first-child{color:var(--hi);font-weight:600}
.why{margin:14px 0 0;padding-left:18px;display:grid;gap:8px;font-size:14px;color:var(--dim)}
.why b{color:var(--text)}
@media (max-width:520px){
  .form{grid-template-columns:1fr}
  header.top h1{font-size:23px}
  .card{padding:14px}
  .side{padding:13px 14px}
}
@media (max-width:360px){
  .nums b{font-size:15px}
  .stat>b{font-size:19px}
}
@media (hover:hover){button.primary:hover{background:#1e53e5}button.ghost:hover{color:var(--hi);border-color:var(--dim2)}.seg button:hover:not([aria-pressed=true]){color:var(--hi)}}
`;

// Client script. Plain ES5-style strings (no template literals) so it can live inside the page template.
const JS = `
(function(){
var $=function(id){return document.getElementById(id)};
var store={get:function(k,d){try{var v=JSON.parse(localStorage.getItem(k));return v==null?d:v}catch(e){return d}},
  set:function(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};
var INSTR={MES:{pv:5,tick:0.25},MNQ:{pv:2,tick:0.25}};
var MAX_MICROS_PER_MINI=10;
var nyDate=function(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())};
var nyMin=function(){var p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).split(':');return (+p[0])*60+(+p[1])};
var num=function(s){if(s==null)return null;var v=parseFloat(String(s).replace(/[$,\\s]/g,''));return isFinite(v)?v:null};
var px=function(x){return x.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})};
var usd=function(x){var r=Math.round(x);return (r<0?'\\u2212$':'$')+Math.abs(r).toLocaleString('en-US')};
var pts=function(x){return (Math.round(x*100)/100).toLocaleString('en-US')};
var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
var hm12=function(m){m=((m%1440)+1440)%1440;var h=Math.floor(m/60),mm=m%60;return ((h%12)||12)+':'+(mm<10?'0':'')+mm+(h<12?' AM':' PM')};

/* account: from the Futures practice settings, then this page's own overrides */
var FUT=store.get('ppfut.set',{});
var ACC_LABELS={i25:'25K Intraday',e25:'25K EOD',i50:'50K Intraday',e50:'50K EOD'};
var CFG=store.get('plan.cfg',{});
function defaults(){
  var dd=FUT.dd||1000;
  var risk=Math.round(dd*0.10);
  var maxLoss=2;
  return {dd:dd,daily:FUT.daily>0?FUT.daily:risk*maxLoss,risk:risk,maxLoss:maxLoss,buf:0,maxMini:FUT.maxMini||4};
}
function eff(){
  var d=defaults();
  var dd=CFG.dd!=null?CFG.dd:d.dd;
  var risk=CFG.risk!=null?CFG.risk:Math.round(dd*0.10);
  var maxLoss=CFG.maxLoss!=null?CFG.maxLoss:d.maxLoss;
  var daily=CFG.daily!=null?CFG.daily:(FUT.daily>0?FUT.daily:risk*maxLoss);
  return {dd:dd,daily:daily,risk:risk,maxLoss:maxLoss,buf:CFG.buf!=null?CFG.buf:0,minStop:CFG.minStop!=null?CFG.minStop:null,maxMini:d.maxMini};
}

/* today: resets itself on a new New York date */
var T=store.get('plan.today',{});
function freshDay(){var keep={src:T.src,trade:T.trade||'MES'};T={date:nyDate(),losses:0,pnl:'',post:'',src:keep.src||null,trade:keep.trade,spyPx:'',mesPx:'',dataPst:'',noData:false,checks:{}};saveT()}
function saveT(){store.set('plan.today',T)}
if(T.date!==nyDate())freshDay();
if(!T.trade)T.trade='MES';

/* parse "Over a --> b --> c / Under x --> y --> z" */
function parse(txt){
  var t=String(txt||'').replace(/\\u2014|\\u2013/g,'-').replace(/-+>|\\u2192/g,' ').replace(/[,\\n\\r\\/|]/g,' ');
  var toks=t.split(/\\s+/),up=[],dn=[],side=0;
  for(var i=0;i<toks.length;i++){
    var w=toks[i].toLowerCase();
    if(w.indexOf('over')>=0||w.indexOf('above')>=0){side=1;continue}
    if(w.indexOf('under')>=0||w.indexOf('below')>=0){side=-1;continue}
    var v=parseFloat(w.replace(/[^0-9.]/g,''));
    if(!isFinite(v)||v<=0||!/[0-9]/.test(w)||w.charAt(0)==='@')continue;
    if(side===1)up.push(v);else if(side===-1)dn.push(v);
  }
  return {up:up,dn:dn};
}
function guessSrc(L){var v=(L.up[0]||L.dn[0]);if(!v)return null;return v<2000?'SPY':v<12000?'MES':'MNQ'}

/* conversion */
function ratio(){
  if(T.src==='SPY'&&T.trade==='MES'){
    /* both typed, or both recorded: never one of each */
    var s=num(T.spyPx),m=num(T.mesPx);
    if(s&&m)return m/s;
    return DATA.ratio?DATA.ratio.mes/DATA.ratio.spy:null;
  }
  return T.src===T.trade?1:null;
}
var ceilT=function(x,t){return Math.ceil(x/t-1e-9)*t},floorT=function(x,t){return Math.floor(x/t+1e-9)*t},roundT=function(x,t){return Math.round(x/t)*t};

function minStop(){var e=eff();if(e.minStop)return e.minStop;var n=DATA.noise[T.trade];return n?roundT(n.m5,0.25):(T.trade==='MES'?15:100)}

function planSide(isLong,lv,oppLv,r){
  var e=eff(),I=INSTR[T.trade],tk=I.tick;
  var conv=function(v){return v*r};
  var raw=conv(lv[0]);
  var entry=isLong?ceilT(raw+e.buf,tk):floorT(raw-e.buf,tk);
  var floor=minStop(),oppDist=null,widened=false,dist;
  if(oppLv!=null){oppDist=isLong?entry-conv(oppLv):conv(oppLv)-entry}
  if(oppDist==null||oppDist<floor){dist=floor;widened=oppDist!=null}else dist=oppDist;
  dist=roundT(dist,tk);
  var stop=isLong?entry-dist:entry+dist;
  var tg=[];for(var i=1;i<lv.length&&i<3;i++){var c=conv(lv[i]);var p=isLong?floorT(c-e.buf,tk):ceilT(c+e.buf,tk);var d=isLong?p-entry:entry-p;if(d>0)tg.push({px:p,d:d,raw:lv[i]})}
  var riskPer=dist*I.pv;
  var maxC=T.trade==='MES'||T.trade==='MNQ'?e.maxMini*MAX_MICROS_PER_MINI:e.maxMini;
  var n=Math.min(Math.floor(e.risk/riskPer+1e-9),maxC);
  tg.forEach(function(t){t.usd=t.d*I.pv;t.R=t.d/dist;t.be=1/(1+t.R)});
  var best=tg.length?tg[tg.length-1]:null;
  var v='take',why=[];
  if(n<1){v='skip';why.push(['bad','One contract risks '+usd(riskPer)+', more than your '+usd(e.risk)+' per-trade limit.'+(T.trade==='MNQ'?' MES risks far less per point.':'')])}
  if(!best){v='skip';why.push(['bad','No target past the entry, so there is nothing to aim for.'])}
  else if(best.R<0.6){v='skip';why.push(['bad','His furthest target pays '+best.R.toFixed(2)+'\\u00d7 the risk. You would need to win '+Math.round(best.be*100)+'% of the time just to break even.'])}
  else if(best.R<1){if(v==='take')v='careful';why.push(['warn','Pays less than it risks ('+best.R.toFixed(2)+'\\u00d7). Needs a '+Math.round(best.be*100)+'% win rate to break even, so take only the cleanest version of it.'])}
  else why.push(['ok','His furthest target pays '+best.R.toFixed(2)+'\\u00d7 the risk (break-even win rate '+Math.round(best.be*100)+'%).']);
  if(widened)why.push(['warn','His opposite level is only '+pts(oppDist)+' points away, inside a normal 5-minute swing, so the stop is widened to '+pts(dist)+'.']);
  else if(oppDist!=null)why.push(['ok','Stop sits at his opposite level, '+pts(dist)+' points away.']);
  else why.push(['warn','No opposite level in the post, so the stop uses the normal 5-minute swing ('+pts(dist)+' points).']);
  if(n>=1&&v!=='skip')why.push(['ok',n+(n===1?' contract keeps':' contracts keep')+' a stop-out at '+usd(riskPer*n)+', inside your '+usd(e.risk)+' limit.']);
  return {isLong:isLong,lv:lv,entry:entry,raw:raw,stop:stop,dist:dist,tg:tg,riskPer:riskPer,n:n,v:v,why:why};
}

/* day status: done for the day / waiting for data / clear */
function dayStatus(){
  var e=eff(),p=num(T.pnl)||0;
  if(T.losses>=e.maxLoss)return {k:'stop',t:'Done for today: '+T.losses+' losses. Close the platform. The levels will be there tomorrow.'};
  if(e.daily>0&&p<=-e.daily)return {k:'stop',t:'Done for today: down '+usd(-p)+', at your '+usd(e.daily)+' daily limit.'};
  var rel=releaseEt();
  if(rel!=null&&nyMin()<rel){var m=rel-nyMin();return {k:'wait',t:'Data at '+hm12(rel)+' ET, in '+(m>=60?Math.floor(m/60)+' h '+(m%60)+' min':m+' min')+'. No entries before it.'}}
  return null;
}
function releaseEt(){
  if(T.noData)return 570;
  if(!T.dataPst)return null;
  var p=T.dataPst.split(':');return (+p[0])*60+(+p[1])+180;
}

function render(){
  var e=eff(),L=parse(T.post),st=dayStatus();
  /* today */
  $('lossTxt').textContent=T.losses+' / '+e.maxLoss;
  if(document.activeElement!==$('pnl'))$('pnl').value=T.pnl||'';
  var p=num(T.pnl)||0;
  $('pnlLeft').textContent=!(e.daily>0)?'':p<=-e.daily?'Daily limit reached':p<0?usd(e.daily+p)+' left of your '+usd(e.daily)+' daily limit':'Daily limit '+usd(e.daily);
  var rel=releaseEt();
  $('dataEt').textContent=T.noData?'No data today: levels count from the 9:30 AM ET open.':rel!=null?'That is '+hm12(rel)+' ET. His levels only count after it.':'Check his #week-in-advance post. His times are Pacific; this shows the Eastern time.';
  $('noData').setAttribute('aria-pressed',T.noData?'true':'false');$('noData').textContent=T.noData?'No data \\u2713':'No data today';
  var b=$('dayBanner');if(st){b.hidden=false;b.className='banner '+st.k;b.textContent=st.t}else b.hidden=true;

  /* paste */
  var segs=function(id,val){var bs=$(id).querySelectorAll('button');for(var i=0;i<bs.length;i++)bs[i].setAttribute('aria-pressed',bs[i].getAttribute('data-v')===val?'true':'false')};
  segs('srcSeg',T.src);segs('tradeSeg',T.trade);
  var r=ratio(),conv=T.src==='SPY'&&T.trade==='MES';
  $('convBox').hidden=!conv;
  if(conv){
    if(document.activeElement!==$('spyPx'))$('spyPx').value=T.spyPx||'';
    if(document.activeElement!==$('mesPx'))$('mesPx').value=T.mesPx||'';
    $('spyPx').placeholder=DATA.ratio?String(DATA.ratio.spy):'e.g. 715.40';
    $('mesPx').placeholder=DATA.ratio?String(DATA.ratio.mes):'e.g. 7185.00';
    var typed=num(T.spyPx)&&num(T.mesPx),half=!typed&&(num(T.spyPx)||num(T.mesPx));
    $('ratioTxt').textContent=!r?'Type the SPY and MES prices to convert.':
      'Ratio '+r.toFixed(4)+(typed?' from the prices you typed.':' from the last recorded prices ('+DATA.ratio.date+' '+DATA.ratio.time+' ET).'+(half?' Type both prices to use yours.':' Type both prices now for an exact conversion: it drifts about 1 MES point a day.'));
  }
  var msg='';
  if((L.up.length||L.dn.length)&&!r){
    msg=T.src==='SPY'&&T.trade==='MNQ'?'SPY levels only convert to MES (both are the S&P 500). For MNQ, use his #mnq-levels post.':
        T.src&&T.src!==T.trade?T.src+' levels can\\u2019t be converted to '+T.trade+': they track different indexes. Switch \\u201cYou trade\\u201d to '+T.src+(T.src==='SPY'?' or MES':'')+'.':'';
  }
  $('convMsg').hidden=!msg;$('convMsg').textContent=msg;

  /* plan */
  var out='',sides=[];
  if(r&&(L.up.length||L.dn.length)){
    if(L.up.length)sides.push(planSide(true,L.up,L.dn.length?L.dn[0]:null,r));
    if(L.dn.length)sides.push(planSide(false,L.dn,L.up.length?L.up[0]:null,r));
  }
  sides.forEach(function(s){
    var lab=s.isLong?'Long over':'Short under';
    var pill=st&&st.k==='stop'?['off','Done today']:s.v==='take'?['take','Take']:s.v==='careful'?['careful','Careful']:['skip','Skip'];
    var conv2=T.src!==T.trade?'his '+T.src+' '+s.lv[0]+' \\u2192 '+T.trade+' '+px(s.raw):T.trade+' '+px(s.entry);
    var cells='<div class="entry"><span>Entry</span><b>'+px(s.entry)+'</b><i>after a 1-min close '+(s.isLong?'above':'below')+'</i></div>'+
      '<div class="stop"><span>Stop</span><b>'+px(s.stop)+'</b><i>'+pts(s.dist)+' pts \\u00b7 '+usd(s.riskPer)+' each</i></div>';
    s.tg.forEach(function(t,i){cells+='<div class="tgt"><span>PT'+(i+1)+'</span><b>'+px(t.px)+'</b><i>+'+usd(t.usd)+' each \\u00b7 '+t.R.toFixed(2)+'R</i></div>'});
    if(s.tg.length===1)cells+='<div><span>PT2</span><b>\\u2014</b><i>none posted</i></div>';
    cells+='<div><span>Contracts</span><b>'+(s.n>0?s.n:'0')+'</b><i>'+(s.n>0?'risking '+usd(s.riskPer*s.n):'over your limit')+'</i></div>';
    var be=s.tg.length?Math.round(s.tg[s.tg.length-1].be*100)+'%':'\\u2014';
    cells+='<div><span>Break-even win rate</span><b>'+be+'</b><i>at the furthest target</i></div>';
    out+='<article class="side '+(s.isLong?'long':'short')+'"><div class="sideh"><h3>'+lab+' '+esc(px(s.entry))+'<small>'+esc(conv2)+'</small></h3><span class="pill '+pill[0]+'">'+pill[1]+'</span></div>'+
      '<div class="nums">'+cells+'</div><ul class="reasons">'+s.why.map(function(w){return '<li class="'+w[0]+'">'+esc(w[1])+'</li>'}).join('')+'</ul></article>';
  });
  $('sides').innerHTML=out;
  $('planEmpty').hidden=!!sides.length;
  $('planEmpty').textContent=(L.up.length||L.dn.length)?'Fix the setting above to see the plan.':'Paste his post above and the plan appears here.';
  $('sendRow').hidden=!sides.length;
  render.sides=sides;

  /* checklist */
  var CL=[
    ['data','It is after the data release'+(rel!=null?' ('+hm12(rel)+' ET)':'')+'.'],
    ['first','This is the first time price has reached this level since then.'],
    ['close','A 1-minute candle closed past the level. A touch is not enough.'],
    ['bracket','The stop and target go in with the entry, as one bracket order.'],
    ['size','Size is no bigger than the plan says.'],
    ['pt1','At PT1, take some off and move the stop to your entry.'],
    ['noflip','If stopped out: no flipping to the other side.']
  ];
  $('checks').innerHTML=CL.map(function(c){return '<li><label><input type="checkbox" data-k="'+c[0]+'"'+(T.checks[c[0]]?' checked':'')+'><span>'+esc(c[1])+'</span></label></li>'}).join('');

  /* account */
  var d=defaults();
  var setPh=function(id,val,def){var el=$(id);if(document.activeElement!==el)el.value=val!=null?val:'';el.placeholder=String(def)};
  setPh('cDd',CFG.dd,d.dd);setPh('cDaily',CFG.daily,(FUT.daily>0?FUT.daily:Math.round((CFG.dd!=null?CFG.dd:d.dd)*0.10)*(CFG.maxLoss!=null?CFG.maxLoss:2)));
  setPh('cRisk',CFG.risk,Math.round((CFG.dd!=null?CFG.dd:d.dd)*0.10));setPh('cLoss',CFG.maxLoss,2);setPh('cBuf',CFG.buf,0);
  setPh('cMin',CFG.minStop,DATA.noise[T.trade]?roundT(DATA.noise[T.trade].m5,0.25):'');
  $('acctSum').textContent=usd(e.risk)+' a trade \\u00b7 '+e.maxLoss+' losses max';
  $('acctFrom').textContent='Starting values come from your Futures practice settings'+(FUT.acct&&ACC_LABELS[FUT.acct]?' ('+ACC_LABELS[FUT.acct]+')':'')+': '+usd(d.dd)+' trailing drawdown. Per-trade risk defaults to 10% of it.';

  /* noise facts */
  var rows='';['MES','MNQ'].forEach(function(s){var n=DATA.noise[s];if(!n)return;var pv=INSTR[s].pv;
    rows+='<tr><td>'+s+'</td><td>'+pts(n.m5)+' pts</td><td>'+usd(n.m5*pv)+'</td><td>'+usd(n.m5hi*pv)+'</td></tr>'});
  $('noiseTbl').innerHTML=rows?'<table><thead><tr><th></th><th>Normal 5-min swing</th><th>Per contract</th><th>Big swing (1 in 10)</th></tr></thead><tbody>'+rows+'</tbody></table><p class="hint">9:30\\u201311:00 AM ET, last '+(DATA.noise.MES||DATA.noise.MNQ).days+' recorded days.</p>':'';
}

/* events */
$('lossPlus').onclick=function(){T.losses++;saveT();render()};
$('lossMinus').onclick=function(){T.losses=Math.max(0,T.losses-1);saveT();render()};
$('pnl').oninput=function(){T.pnl=this.value;saveT();render()};
$('dataPst').value=T.dataPst||'';
$('dataPst').oninput=$('dataPst').onchange=function(){T.dataPst=this.value;if(this.value)T.noData=false;saveT();render()};
$('noData').onclick=function(){T.noData=!T.noData;if(T.noData){T.dataPst='';$('dataPst').value=''}saveT();render()};
$('post').value=T.post||'';
$('post').oninput=function(){var prev=parse(T.post),L=parse(this.value);T.post=this.value;
  var g=guessSrc(L),pg=guessSrc(prev);if(g&&g!==pg){T.src=g;if(g==='MNQ')T.trade='MNQ';else if(g==='MES'||g==='SPY')T.trade='MES'}
  saveT();render()};
var segClick=function(id,key){$(id).onclick=function(ev){var b=ev.target.closest('button');if(!b)return;T[key]=b.getAttribute('data-v');saveT();render()}};
segClick('srcSeg','src');segClick('tradeSeg','trade');
$('spyPx').oninput=function(){T.spyPx=this.value;saveT();render()};
$('mesPx').oninput=function(){T.mesPx=this.value;saveT();render()};
$('checks').onchange=function(ev){var k=ev.target.getAttribute('data-k');if(!k)return;T.checks[k]=ev.target.checked;saveT()};
var cfgIn=function(id,key,isInt){$(id).oninput=function(){var v=num(this.value);if(v==null||v<0)delete CFG[key];else CFG[key]=isInt?Math.round(v):v;store.set('plan.cfg',CFG);render()}};
cfgIn('cDd','dd');cfgIn('cDaily','daily');cfgIn('cRisk','risk');cfgIn('cLoss','maxLoss',true);cfgIn('cBuf','buf');cfgIn('cMin','minStop');
$('cReset').onclick=function(){CFG={};store.set('plan.cfg',CFG);['cDd','cDaily','cRisk','cLoss','cBuf','cMin'].forEach(function(id){$(id).value=''});render()};

/* send the levels to the Futures practice chart (its own horizontal lines, stored per symbol) */
$('sendBtn').onclick=function(){
  var sides=render.sides||[];if(!sides.length)return;
  var LV=store.get('ppfut.lvl',{}),sym=T.trade;
  var keep=(LV[sym]||[]).filter(function(l){return String(l.id).indexOf('plan')!==0});
  var add=[],k=0,line=function(p,color,w,style,text){add.push({id:'plan'+(k++),price:p,color:color,width:w,style:style,text:text})};
  var entries=sides.map(function(s){return s.entry});
  sides.forEach(function(s){
    var c=s.isLong?'#22ab94':'#f7525f';
    var stopHere=sides.some(function(o){return o!==s&&Math.abs(o.stop-s.entry)<=0.5});
    line(s.entry,c,2,0,(s.isLong?'OVER ':'UNDER ')+px(s.entry)+(stopHere?(s.isLong?' \\u00b7 short stop':' \\u00b7 long stop'):''));
    s.tg.forEach(function(t,i){line(t.px,c,1,1,(s.isLong?'Long ':'Short ')+'PT'+(i+1)+' '+px(t.px))});
    /* the stop usually IS the other side's entry; only draw it when it was widened elsewhere */
    var onEntry=entries.some(function(p){return Math.abs(p-s.stop)<=0.5});
    if(!onEntry)line(s.stop,'#ff9800',1,2,(s.isLong?'Long':'Short')+' stop '+px(s.stop));
  });
  LV[sym]=keep.concat(add);store.set('ppfut.lvl',LV);
  $('sendMsg').innerHTML='Saved '+add.length+' lines on '+sym+'. <a class="go" href="futures.html#sym='+sym+'">Open Futures practice on '+sym+' \\u2192</a>';
};

render();
setInterval(function(){if(T.date!==nyDate()){freshDay();$('post').value='';$('dataPst').value=''}render()},30000);
})();
`;
