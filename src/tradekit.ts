/**
 * The parts the two practice pages share, styled once.
 *
 * Stocks (src/vendor/practice-app.html) and Futures (src/vendor/futures-app.html)
 * are separate apps with separate scripts, and they had drifted into two
 * different-looking products: Next bar was the big blue button on one and Play
 * on the other, one had Buy and Sell on screen on a phone and the other hid
 * them in a sheet, the account line read "Acct" on one and "Balance" on the
 * other, the bottom tabs were styled differently. These classes are the
 * common vocabulary both pages use for the same jobs, so they look and behave
 * the same:
 *
 *   .kh   header row      instrument · price · change ……… clock · help · settings
 *   .ka   account strip   Balance · Today / Open P&L · limits ……… status
 *   .rb   replay bar      back/restart · ▶ Play · Next bar · speed
 *   .qb   order bar       (phone) size · Sell / Buy  or  Put / Call · extra
 *   .qp   position row    (phone) side · size · P&L ……… Close
 *   .bt   bottom tabs     (phone) icon over label, the open one in blue
 *   .kd   dialogs         the "How it works" guide and the "What to replay" picker
 *
 * Colours are TradingView's dark theme, written out rather than read from
 * either page's custom properties, since the two pages name theirs differently.
 */
export const TRADE_KIT_CSS = `
/* ---------- header row ---------- */
.kh{display:flex;align-items:center;gap:10px;min-height:48px;padding:0 10px;flex:0 0 auto;
  border-bottom:1px solid #2a2e39;background:#131722;white-space:nowrap}
.kh .kh-px{font-size:18px;font-weight:600;color:#f0f3fa;letter-spacing:0;font-variant-numeric:tabular-nums}
.kh .kh-chg{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}
.kh .kh-chg.up{color:#22ab94}.kh .kh-chg.dn{color:#f7525f}
.kh .kh-clk{margin-left:auto;text-align:right;line-height:1.2;flex:0 0 auto}
.kh .kh-clk b{display:block;font-size:14px;font-weight:600;color:#f0f3fa;font-variant-numeric:tabular-nums}
.kh .kh-clk small{display:block;font-size:11px;color:#787b86}
.kh .kh-ib{width:36px;height:36px;min-height:0;padding:0;border:0;border-radius:4px;background:transparent;color:#9598a1;
  display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;gap:6px}
.kh .kh-ib:hover{background:#2a2e39;color:#f0f3fa}
.kh .kh-ib svg{width:18px;height:18px}
.kh .kh-ib.wide{width:auto;padding:0 10px;font-size:13px;font-weight:500}
/* the instrument button a phone uses in place of the pickers */
.kh .kh-inst{display:none;align-items:center;gap:6px;height:36px;min-height:0;padding:0 8px 0 10px;border:1px solid #363a45;
  border-radius:6px;background:transparent;color:#f0f3fa;font-size:16px;font-weight:700;flex:0 0 auto}
.kh .kh-inst svg{width:14px;height:14px;color:#787b86}
@media (max-width:899px){
  .kh{gap:8px;padding:0 8px;min-height:50px}
  .kh .kh-inst{display:inline-flex}
  .kh .kh-desk{display:none!important}
  .kh .kh-px{font-size:17px}
  .kh .kh-chg{font-size:12px}
  .kh .kh-ib.wide span{display:none}
  .kh .kh-ib.wide{width:36px;padding:0}
}
@media (max-width:360px){.kh .kh-chg{display:none}}

/* ---------- account strip ---------- */
.ka{display:flex;align-items:center;gap:16px;height:30px;padding:0 12px;flex:0 0 auto;border-bottom:1px solid #2a2e39;
  background:#131722;font-size:12px;color:#787b86;white-space:nowrap;overflow-x:auto;scrollbar-width:none;
  font-variant-numeric:tabular-nums;width:100%;text-align:left;border-radius:0;border-top:0;border-left:0;border-right:0;
  min-height:0;font-weight:400;margin:0}
.ka::-webkit-scrollbar{display:none}
.ka>span{flex:0 0 auto}
.ka b{font-weight:500;color:#f0f3fa;margin-left:4px}
.ka b.up,.ka .up b{color:#22ab94}.ka b.dn,.ka .dn b{color:#f7525f}
.ka .warn,.ka .warn b{color:#ff9800}.ka .bad,.ka .bad b{color:#f7525f}
.ka .ka-end{margin-left:auto}
.ka .ka-chip{display:inline-block;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;letter-spacing:.3px;background:#142852;color:#82a5ff}
.ka .ka-chip.bad{background:#3d1a1f;color:#f7525f}.ka .ka-chip.good{background:#0d3029;color:#22ab94}
.ka .ka-link{color:#5b8cff;font-weight:500}
/* On a phone one line ran the loss limit and drawdown off the right edge, in a
   strip with no sign that it scrolls. It wraps instead. */
@media (max-width:899px){
  .ka{height:auto;min-height:30px;flex-wrap:wrap;row-gap:3px;column-gap:14px;padding:5px 12px;overflow:visible}
  .ka .ka-end{margin-left:0}
}
button.ka{cursor:pointer}
button.ka:hover{background:#1e222d}

/* ---------- replay bar ---------- */
.rb{display:flex;align-items:center;gap:6px;height:54px;padding:7px 10px;flex:0 0 auto;border-top:1px solid #2a2e39;background:#131722;
  position:relative;z-index:12;white-space:nowrap}
.rb button,.rb select{height:40px;min-height:0;margin:0;border-radius:4px;font-size:14px;line-height:1;box-shadow:none}
.rb button:active{transform:none}
.rb .rb-ic{width:42px;padding:0;border:1px solid #363a45;background:transparent;color:#d1d4dc;
  display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
.rb .rb-ic:hover:not(:disabled){background:#2a2e39}
.rb .rb-ic svg{width:18px;height:18px}
.rb .rb-play,.rb .rb-next{flex:0 1 160px;min-width:110px;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:600}
.rb .rb-play{background:#2962ff;border:1px solid #2962ff;color:#fff}
.rb .rb-play:hover:not(:disabled){background:#1e53e5;border-color:#1e53e5}
.rb .rb-play.on{background:transparent;border-color:#363a45;color:#d1d4dc}
.rb .rb-play.on:hover{background:#2a2e39}
.rb .rb-next{background:transparent;border:1px solid #363a45;color:#d1d4dc}
.rb .rb-next:hover:not(:disabled){background:#2a2e39}
.rb .rb-play svg,.rb .rb-next svg{width:16px;height:16px;flex:none}
.rb .rb-speed{width:78px;flex:0 0 auto;padding:0 24px 0 10px;border:1px solid #363a45;background-color:transparent;color:#d1d4dc;text-align:center;text-align-last:center}
.rb .rb-opt{display:flex;align-items:center;gap:7px;color:#787b86;font-size:12px;padding:0 6px;cursor:pointer}
.rb .rb-sep{width:1px;height:24px;background:#2a2e39;flex:none;margin:0 2px}
@media (max-width:899px){
  .rb{height:54px;padding:6px 8px;gap:6px}
  .rb .rb-play,.rb .rb-next{flex:1 1 0;min-width:0;padding:0 8px}
  .rb .rb-desk{display:none!important}
  .rb .rb-speed{width:70px;font-size:16px}
}

/* ---------- order bar and position row (phone) ---------- */
.qb,.qp{display:none}
@media (max-width:899px){
  .qb{display:flex;gap:6px;padding:7px 8px;flex:0 0 auto;border-top:1px solid #2a2e39;background:#131722;align-items:stretch}
  .qb .qb-q{flex:0 0 104px;display:flex;border:1px solid #363a45;border-radius:4px;overflow:hidden;height:auto}
  .qb .qb-q button{width:32px;min-height:0;height:auto;padding:0;border:0;border-radius:0;background:transparent;color:#9598a1;font-size:18px;font-weight:400}
  .qb .qb-q input,.qb .qb-q span{flex:1;min-width:0;width:auto;height:auto;border:0;padding:0;text-align:center;background:transparent;
    font-size:16px;color:#f0f3fa;display:flex;align-items:center;justify-content:center}
  .qb .qb-go{flex:1 1 0;min-width:0;min-height:48px;height:auto;padding:5px 4px;border:0;border-radius:4px;color:#fff;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;line-height:1.2;font-weight:600}
  .qb .qb-go small{font-size:15px;font-weight:600;letter-spacing:.2px}
  .qb .qb-go span{font-size:12px;font-weight:500;opacity:.92}
  .qb .qb-go.sell{background:#f23645}.qb .qb-go.buy{background:#2962ff}
  .qb .qb-go.put{background:#f23645}.qb .qb-go.call{background:#089981}
  .qb .qb-go:disabled,.qb .qb-go.blk{background:#2a2e39;color:#9598a1;opacity:1}
  .qb .qb-x{flex:0 0 auto;min-height:0;height:auto;padding:4px 8px;font-size:11px;line-height:1.35;text-align:left;color:#9598a1;
    border:1px solid #363a45;border-radius:4px;background:transparent;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:0;font-weight:500}
  .qp.show{display:flex;align-items:center;gap:10px;padding:7px 12px;flex:0 0 auto;border-top:1px solid #2a2e39;background:#1e222d;
    font-size:13px;white-space:nowrap;overflow-x:auto;scrollbar-width:none;font-variant-numeric:tabular-nums}
  .qp b.up{color:#22ab94}.qp b.dn{color:#f7525f}
  .qp button{min-height:0;height:30px;padding:0 10px;border:1px solid #363a45;border-radius:4px;background:transparent;font-size:12px;color:#d1d4dc;font-weight:500}
  .qp button.up{color:#22ab94}.qp button.dn{color:#f7525f}
  .qp .qp-x{margin-left:auto;background:#f23645;border-color:#f23645;color:#fff;font-weight:600}
}

/* ---------- bottom tabs (phone) ---------- */
@media (max-width:899px){
  .bt{display:flex!important;flex:0 0 auto;border-top:1px solid #2a2e39;background:#131722;padding:2px 4px env(safe-area-inset-bottom,0px)}
  .bt button{flex:1 1 0;min-width:0;min-height:52px;height:auto;margin:0;padding:6px 2px 5px;border:0;border-radius:4px;background:transparent;
    color:#787b86;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;box-shadow:none;font-weight:500}
  .bt button svg{width:20px;height:20px;display:block}
  .bt button small,.bt button .bt-l{display:block;font-size:11px;font-weight:500;letter-spacing:.2px}
  .bt button:hover{background:transparent;color:#d1d4dc}
  .bt button.on{color:#5b8cff;background:transparent;box-shadow:none}
}
@media (max-width:899px) and (orientation:landscape) and (max-height:520px){
  .bt button{min-height:34px;flex-direction:row;gap:6px;padding:3px 2px}
  .bt button svg{width:16px;height:16px}
  .rb{height:42px;padding:3px 8px}.rb button,.rb select{height:34px}
  .qb{padding:4px 8px}.qb .qb-go{min-height:36px}.qb .qb-go span{display:none}
}

/* ---------- dialogs: the guide and the picker ---------- */
dialog.kd{background:#1e222d;color:#d1d4dc;border:1px solid #363a45;border-radius:8px;padding:20px 22px;max-width:480px;width:calc(100% - 24px);
  box-shadow:0 12px 40px rgba(0,0,0,.65);font-size:13px;line-height:1.45;font-family:-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif}
dialog.kd::backdrop{background:rgba(0,0,0,.65)}
dialog.kd h3{margin:0 0 6px;font-size:17px;font-weight:600;color:#f0f3fa;text-transform:none;letter-spacing:0}
dialog.kd .kd-note{color:#9598a1;font-size:12.5px;margin:0 0 12px;line-height:1.5}
dialog.kd ol{margin:14px 0 4px;padding:0;list-style:none;counter-reset:s}
dialog.kd ol li{counter-increment:s;position:relative;padding:0 0 14px 38px;line-height:1.55;color:#d1d4dc;font-size:13px}
dialog.kd ol li::before{content:counter(s);position:absolute;left:0;top:-1px;width:26px;height:26px;border-radius:50%;
  background:#142852;color:#82a5ff;display:grid;place-content:center;font-weight:600;font-size:13px}
dialog.kd li b{color:#f0f3fa;font-weight:600}
dialog.kd .k{display:inline-block;color:#fff;padding:0 7px;border-radius:3px;font-weight:600;white-space:nowrap}
dialog.kd .k.blue{background:#2962ff}dialog.kd .k.red{background:#f23645}dialog.kd .k.green{background:#089981}
dialog.kd .kd-f{display:flex;flex-direction:column;gap:6px;margin-top:12px;font-size:13px;color:#9598a1}
dialog.kd .kd-f select{width:100%;height:44px;min-height:0;font-size:16px;border-radius:6px;border:1px solid #363a45;font-weight:500;color:#f0f3fa;
  background-color:transparent;padding:0 32px 0 12px;font-family:inherit}
dialog.kd .kd-f .kd-col{display:flex;flex-direction:column;gap:8px}
dialog.kd .kd-f button{height:42px;min-height:0;border:1px solid #363a45;border-radius:6px;background:transparent;color:#d1d4dc;
  display:flex;align-items:center;justify-content:center;gap:8px;font-weight:500;width:100%;font-size:14px}
dialog.kd .kd-f button:hover{background:#2a2e39}
dialog.kd .kd-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}
dialog.kd .kd-btns button{height:38px;min-height:0;padding:0 16px;border:1px solid #363a45;border-radius:4px;background:transparent;color:#d1d4dc;font-weight:500;font-size:13.5px}
dialog.kd .kd-btns button:hover{background:#2a2e39}
dialog.kd .kd-btns button.pri{background:#2962ff;border-color:#2962ff;color:#fff}
dialog.kd .kd-btns button.pri:hover{background:#1e53e5}
`;

/** Puts the kit's stylesheet into a page's <head>, once. */
export function injectTradeKit(html: string): string {
  if (html.includes("/* ---------- header row ---------- */")) return html;
  return html.replace("</head>", `<style>${TRADE_KIT_CSS}</style>\n</head>`);
}
