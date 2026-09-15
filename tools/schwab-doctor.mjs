/**
 * Works out why the Schwab login is not working, one precondition at a time.
 *
 *   node tools/schwab-doctor.mjs
 *
 * "It does not work" has half a dozen causes that look identical from the
 * outside: an app that has not finished being approved, a secret with a stray
 * space, a callback URL that differs by a trailing slash, a code that was
 * already spent, an expired login, a blocked network. This checks each in turn
 * and stops at the first thing that is actually wrong, rather than leaving it
 * to be guessed.
 *
 * It prints no secrets. Keys and tokens are shown only as a length and their
 * last four characters, which is enough to spot a truncated paste and not
 * enough to be worth hiding from a screenshot.
 */
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = await import(pathToFileURL(join(ROOT, "src", "schwab.ts")).href);

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const note = (m) => console.log(`        ${m}`);
/** Enough of a secret to spot a truncated or padded paste, and no more. */
const peek = (v) => `${v.length} chars, ends "${v.slice(-4)}"`;

console.log("Schwab setup check\n");
let stop = false;

/* 1. the app's own credentials ------------------------------------- */
const key = process.env.SCHWAB_APP_KEY, secret = process.env.SCHWAB_APP_SECRET;
if (!key || !secret) {
  bad(!key && !secret ? "SCHWAB_APP_KEY and SCHWAB_APP_SECRET are not set"
    : `${!key ? "SCHWAB_APP_KEY" : "SCHWAB_APP_SECRET"} is not set`);
  note("Set both in your shell, then run this again:");
  note("  export SCHWAB_APP_KEY=...   export SCHWAB_APP_SECRET=...");
  note("Put them in your shell profile so they survive a new terminal.");
  stop = true;
} else {
  ok(`SCHWAB_APP_KEY   ${peek(key)}`);
  ok(`SCHWAB_APP_SECRET ${peek(secret)}`);
  // A pasted credential that kept its quotes or a space is the classic one.
  for (const [name, v] of [["SCHWAB_APP_KEY", key], ["SCHWAB_APP_SECRET", secret]]) {
    if (v !== v.trim()) { bad(`${name} has whitespace around it -- re-export it without spaces`); stop = true; }
    if (/^["']|["']$/.test(v)) { bad(`${name} still has quote characters in the value itself`); stop = true; }
  }
}

/* 2. the callback URL ---------------------------------------------- */
const redirect = process.env.SCHWAB_REDIRECT_URI || "https://127.0.0.1";
console.log("");
ok(`callback URL      ${redirect}${process.env.SCHWAB_REDIRECT_URI ? "" : "   (the default; set SCHWAB_REDIRECT_URI to change it)"}`);
if (!redirect.startsWith("https://")) {
  bad("Schwab only accepts an https callback URL");
  stop = true;
}
note("This must match the app's callback URL on developer.schwab.com exactly:");
note("scheme, host, any port, and any trailing slash. A difference here reads as invalid_grant.");

/* 3. can we even reach them --------------------------------------- */
console.log("");
try {
  const r = await fetch("https://api.schwabapi.com/v1/oauth/authorize", {
    method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  // Any status will do. The endpoint expects parameters, so a 4xx here is
  // normal and says nothing about the credentials; what is being tested is
  // only that something answered rather than the connection failing outright.
  ok(`api.schwabapi.com answered (HTTP ${r.status}; any status is fine here)`);
  if (r.status === 403) note("A 403 can also be a company proxy or VPN refusing, rather than Schwab.");
} catch (e) {
  bad(`could not connect to api.schwabapi.com: ${e.message}`);
  note("A firewall, VPN or proxy in the way looks exactly like a credential problem.");
  stop = true;
}

/* 4. the login itself ---------------------------------------------- */
console.log("");
const tokens = await S.loadTokens();
if (!tokens) {
  let exists = false;
  try { await stat(S.TOKEN_FILE); exists = true; } catch { /* not there at all */ }
  bad(exists ? "the token file exists but has no refresh token in it" : "not logged in yet (no token file)");
  note(`looked in ${S.TOKEN_FILE}`);
  note("Run: node tools/schwab-login.mjs");
} else {
  const hours = S.refreshHoursLeft(tokens);
  const live = Date.now() < tokens.expiresAt;
  ok(`logged in         refresh token ${peek(tokens.refresh)}`);
  console.log(`  ${hours > 0 ? "ok   " : "FAIL "} login has ${hours > 0 ? `about ${hours.toFixed(0)}h left` : "expired"}` +
    `   (access token ${live ? "still valid" : "stale, will refresh on use"})`);
  if (hours <= 0) note("Run: node tools/schwab-login.mjs");
  else if (!stop) {
    // The real test: ask Schwab for a token and see what it says.
    console.log("");
    try {
      const t = await S.accessToken();
      if (t) ok(`Schwab accepted the credentials and issued an access token (${peek(t)})`);
      else bad("Schwab returned no access token, but did not say why");
    } catch (e) {
      bad(e.message.split("\n")[0]);
      for (const line of e.message.split("\n").slice(1)) note(line.trim());
    }
  }
}

/* 5. what to do next ----------------------------------------------- */
console.log("");
if (!stop && key && secret) {
  console.log("If the login itself is the problem, start again from this link:\n");
  console.log("  " + S.authorizeUrl() + "\n");
  console.log("Sign in, approve, let the browser fail to load the callback, then paste the whole");
  console.log("address bar into: node tools/schwab-login.mjs");
  console.log("");
  console.log("The code in that address is single-use and lasts a few minutes, so paste it straight");
  console.log("away and start from the link again rather than reusing an old address.");
} else {
  console.log("Fix the FAIL above, then run this again.");
}
