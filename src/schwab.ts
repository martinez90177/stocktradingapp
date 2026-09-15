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

const AUTH = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN = "https://api.schwabapi.com/v1/oauth/token";

/** Where the tokens live. Ignored by git; see .gitignore. */
export const TOKEN_FILE = ".schwab-tokens.json";

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
  } catch {
    return null;
  }
  if (!r.ok) {
    // The body can name the reason (an expired refresh token, a redirect URI
    // that does not match what was registered) but can also carry the grant, so
    // only the status and Schwab's short error field are surfaced.
    let why = "";
    try { why = ((await r.json()) as { error?: string })?.error ?? ""; } catch { /* no body */ }
    throw new Error(`Schwab refused the token request (HTTP ${r.status}${why ? `, ${why}` : ""})`);
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
