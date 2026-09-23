/**
 * Logs in to Schwab (thinkorswim) once, so the recorder can quote real prices.
 *
 *   node tools/schwab-login.mjs
 *
 * Before the first run, at https://developer.schwab.com: create an app, add
 * the "Market Data Production" product, and set its callback URL. A new app
 * sits at "Approved - Pending" for a day or two before it turns "Ready For
 * Use", and nothing here works until it does -- the login will simply be
 * refused. Then put the app's key and secret in the environment, with the
 * callback URL if it is not the default:
 *
 *   SCHWAB_APP_KEY=...  SCHWAB_APP_SECRET=...  [SCHWAB_REDIRECT_URI=https://127.0.0.1]
 *
 * TWO DIFFERENT ACCOUNTS ARE INVOLVED, and this catches everyone out.
 * developer.schwab.com needs its own registration, separate from the Schwab
 * brokerage login -- a different username and password, created just to hold
 * the app. The link this prints is the other one: the OAuth approval, signed
 * in with the **brokerage** credentials, the ones used for thinkorswim. That
 * is also where the brokerage account to expose is chosen. Market data
 * entitlements follow that account, not the developer profile, and the
 * brokerage account has to be thinkorswim-enabled.
 *
 * So: this prints a link, you sign in with your trading credentials and
 * approve, the browser lands on a page that will not load -- that is expected,
 * the callback is not a real server -- and you paste the address bar back here.
 * The one-time code in it is traded for tokens, written to
 * .schwab-tokens.json.
 *
 * The refresh token lasts seven days, so this is about a weekly job. The
 * recorder refreshes the short-lived access token by itself, and says how long
 * the login has left when it starts.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = await import(pathToFileURL(join(ROOT, "src", "schwab.ts")).href);

const creds = S.appCreds();
if (!creds) {
  console.error("SCHWAB_APP_KEY and SCHWAB_APP_SECRET are not set.\n");
  console.error("Create an app at https://developer.schwab.com, add the Market Data Production");
  console.error("product, then set them in your environment along with the callback URL you");
  console.error("registered (SCHWAB_REDIRECT_URI, default https://127.0.0.1).\n");
  console.error("The developer portal needs its OWN registration, separate from your Schwab");
  console.error("brokerage login. The app lives there; the brokerage login is used later, when");
  console.error("you approve the app and pick which account it may read.\n");
  console.error("A new app is not usable straight away either: it stays 'Approved - Pending' for");
  console.error("a day or two and only works once it reads 'Ready For Use'.");
  process.exit(1);
}

const existing = await S.loadTokens(S.TOKEN_FILE);
if (existing) {
  const h = S.refreshHoursLeft(existing);
  console.log(h > 0
    ? `There is already a login with about ${h.toFixed(0)}h left on it. Carry on to replace it.\n`
    : "The existing login has expired. Replacing it.\n");
}

console.log("1. Open this in a browser and sign in to Schwab:\n");
console.log("   " + S.authorizeUrl() + "\n");
console.log(`2. Approve the app. The browser will then try to reach ${creds.redirect} and fail to load it.`);
console.log("   That is expected: the callback is not a real server.\n");
console.log("3. Copy the whole address out of the address bar and paste it here.\n");

const rl = createInterface({ input: stdin, output: stdout });
const pasted = (await rl.question("Redirected URL: ")).trim();
rl.close();

let code = null;
try {
  code = new URL(pasted).searchParams.get("code");
} catch {
  // Someone may paste just the code rather than the whole URL.
  if (pasted && !pasted.includes(" ") && !pasted.startsWith("http")) code = pasted;
}
if (!code) {
  console.error("\nNo ?code= was found in that. Paste the full address the browser landed on.");
  process.exit(1);
}

let tokens;
try {
  tokens = await S.exchangeCode(code);
} catch (e) {
  console.error(`\n${e.message}`);
  console.error("The usual causes are a callback URL that does not match the one registered on the app,");
  console.error("or a code that has already been used -- they are single-use. Start again from the link.");
  process.exit(1);
}
if (!tokens) {
  console.error("\nSchwab returned no token. Check the app key and secret, then try again.");
  process.exit(1);
}

await S.saveTokens(tokens, S.TOKEN_FILE);
console.log(`\nLogged in. Tokens written to ${S.TOKEN_FILE} (git ignores it, and it is readable only by you).`);
console.log(`The refresh token lasts about ${S.refreshHoursLeft(tokens).toFixed(0)}h; run this again when it runs out.\n`);
console.log("Check the feed is live:   node tools/record-options.mjs --check");
