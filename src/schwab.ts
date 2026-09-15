/**
 * Schwab (thinkorswim) credentials: the one place tokens are read, refreshed
 * and written.
 *
 * Schwab's Trader API is the successor to TD Ameritrade's, and it is the feed
 * worth having here: a chain endpoint that serves real-time quotes to account
 * holders, and that states outright whether what it just gave you was delayed.
 * The cost is OAuth rather than a bearer token, and tokens that do not last:
 * an access token is good for thirty minutes and a refresh token for seven
 * days, so a session's recording refreshes a dozen times and the login has to
 * be done again about once a week.
 *
 * Nothing here is ever logged or committed. The app key and secret come from
 * the environment; the tokens live in .schwab-tokens.json, which is ignored by
 * git and written readable only by its owner.
 */
import { readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AUTH = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN = "https://api.schwabapi.com/v1/oauth/token";

/**
 * Where the tokens live: beside the repository, not beside whatever directory
 * a tool happened to be run from. Resolving it against the working directory
 * meant a login done from the repo root was invisible to a tool run from
 * anywhere else, which reads as "not logged in" rather than as the path
 * problem it is. Ignored by git; see .gitignore.
 */
export const TOKEN_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".schwab-tokens.json");

export interface SchwabTokens {
  access: string;
  refresh: string;
  /** When the access token stops working, epoch ms. */
  expiresAt: number;
  /** When the refresh token does, epoch ms: seven days from the login. */
  refreshExpiresAt: number;
}

/** The app's own credentials, or null where they have not been set. */
export function appCreds(): { key: string; secret: string; redirect: string } | null {
  const key = process.env.SCHWAB_APP_KEY, secret = process.env.SCHWAB_APP_SECRET;
  if (!key || !secret) return null;
  return { key, secret, redirect: process.env.SCHWAB_REDIRECT_URI || "https://127.0.0.1" };
}

/** Where to send a browser to authorize this app, once. */
export function authorizeUrl(): string | null {
  const c = appCreds();
  if (!c) return null;
  return `${AUTH}?client_id=${encodeURIComponent(c.key)}&redirect_uri=${encodeURIComponent(c.redirect)}`;
}

async function tokenPost(body: Record<string, string>): Promise<SchwabTokens | null> {
  const c = appCreds();
  if (!c) return null;
  const basic = Buffer.from(`${c.key}:${c.secret}`).toString("base64");
  let r: Response;
  try {
    r = await fetch(TOKEN, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // A network failure is not a refusal, and saying so saves hunting for a
    // credential problem that is not there.
    throw new Error(`Could not reach Schwab (${(e as Error).message}). Check the connection and try again.`);
  }
  if (!r.ok) {
    // The body names the reason. It can also carry a grant, so only the two
    // documented error fields are read out of it, never the whole thing.
    let code = "", detail = "";
    try {
      const j = (await r.json()) as { error?: string; error_description?: string };
      code = j?.error ?? "";
      detail = j?.error_description ?? "";
    } catch { /* no body */ }
    throw new Error(`Schwab refused the token request (HTTP ${r.status}` +
      `${code ? `, ${code}` : ""}${detail ? `: ${detail}` : ""}).` + explain(r.status, code));
  }
  const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  const now = Date.now();
  return {
    access: j.access_token,
    refresh: j.refresh_token ?? body.refresh_token ?? "",
    expiresAt: now + (j.expires_in ?? 1800) * 1000,
    // Schwab does not say when the refresh token dies, and it is seven days.
    // On a refresh the original login's clock keeps running, so it is only set
    // here for a fresh authorization; refresh() carries the old one forward.
    refreshExpiresAt: now + 7 * 86400_000,
  };
}

/**
 * What Schwab's refusals actually mean. The codes are terse and two of them are
 * routinely misread: an unapproved app and a bad secret both come back as
 * invalid_client, and a stale paste and a mismatched callback URL both come
 * back as invalid_grant.
 */
function explain(status: number, code: string): string {
  if (code === "invalid_client" || status === 401) {
    return "\n  Usually one of: the app key or secret is wrong, or the app is not live yet." +
      "\n  A new app sits at 'Approved - Pending' for a day or two; it only works at 'Ready For Use'.";
  }
  if (code === "invalid_grant") {
    return "\n  Usually one of: the code was already used (they are single-use, so start again from the link)," +
      "\n  the code went stale (they last a few minutes), or SCHWAB_REDIRECT_URI does not match the callback" +
      "\n  URL registered on the app exactly -- including https, any port, and any trailing slash.";
  }
  if (code === "unsupported_token_type") {
    return "\n  This usually means the app is not fully provisioned yet. Check it reads 'Ready For Use'" +
      "\n  on developer.schwab.com, and that the Market Data Production product is added to it.";
  }
  if (String(code).includes("refresh_token")) {
    return "\n  The seven days are up. Run: node tools/schwab-login.mjs";
  }
  return "";
}

/** Trades the one-time code from the redirect for a pair of tokens. */
export async function exchangeCode(code: string): Promise<SchwabTokens | null> {
  const c = appCreds();
  if (!c) return null;
  return tokenPost({ grant_type: "authorization_code", code, redirect_uri: c.redirect });
}

export async function loadTokens(file = TOKEN_FILE): Promise<SchwabTokens | null> {
  try {
    const t = JSON.parse(await readFile(file, "utf8")) as SchwabTokens;
    return t?.refresh ? t : null;
  } catch {
    return null;
  }
}

export async function saveTokens(t: SchwabTokens, file = TOKEN_FILE): Promise<void> {
  await writeFile(file, JSON.stringify(t), "utf8");
  // Tokens are as good as the password; nobody else on the machine needs them.
  try { await chmod(file, 0o600); } catch { /* not every filesystem has modes */ }
}

let cached: SchwabTokens | null = null;

/**
 * A usable access token, refreshing it a minute before it expires. Returns null
 * where Schwab was never set up, and throws where it was but the refresh token
 * has run out -- the difference between "not configured" and "log in again"
 * being worth keeping.
 */
export async function accessToken(file = TOKEN_FILE): Promise<string | null> {
  if (!appCreds()) return null;
  if (!cached) cached = await loadTokens(file);
  if (!cached) return null;
  if (Date.now() < cached.expiresAt - 60_000) return cached.access;
  if (Date.now() > cached.refreshExpiresAt) {
    throw new Error("The Schwab refresh token has expired (they last seven days). Run: node tools/schwab-login.mjs");
  }
  const next = await tokenPost({ grant_type: "refresh_token", refresh_token: cached.refresh });
  if (!next) return null;
  // Refreshing does not restart the seven days; the original login's clock runs on.
  next.refreshExpiresAt = cached.refreshExpiresAt;
  if (!next.refresh) next.refresh = cached.refresh;
  cached = next;
  await saveTokens(next, file);
  return next.access;
}

/** How long the login has left, in hours, for a warning before a session starts. */
export function refreshHoursLeft(t: SchwabTokens): number {
  return Math.max(0, (t.refreshExpiresAt - Date.now()) / 3600_000);
}

/**
 * Minute bars from Schwab, the same series thinkorswim charts from.
 *
 * Returns null where Schwab is not set up, so a caller can fall back rather
 * than fail; an empty array means it answered and had nothing, which is a
 * different thing and worth not confusing.
 */
export async function minuteBars(
  symbol: string,
  days: number,
  file = TOKEN_FILE,
): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number }[] | null> {
  const token = await accessToken(file);
  if (!token) return null;
  const end = Date.now(), start = end - Math.max(1, days) * 86400_000;
  const url = "https://api.schwabapi.com/marketdata/v1/pricehistory" +
    `?symbol=${encodeURIComponent(symbol)}&periodType=day&frequencyType=minute&frequency=1` +
    `&needExtendedHoursData=true&startDate=${start}&endDate=${end}`;
  let r: Response;
  try {
    r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const j = (await r.json()) as { candles?: { open: number; high: number; low: number; close: number; volume: number; datetime: number }[] };
  if (!Array.isArray(j?.candles)) return null;
  return j.candles
    .filter((c) => c.datetime > 0 && c.open > 0)
    .map((c) => ({ t: c.datetime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume ?? 0 }))
    .sort((a, b) => a.t - b.t);
}
