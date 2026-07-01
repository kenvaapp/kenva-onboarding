/**
 * lib.ts — shared helpers for the onboarding flow.
 *
 * The onboarding side WRITES what the MCP server later READS:
 *   - the per-user Google Drive refresh token -> Supabase Vault
 *   - the user's account_state row (starts their trial, marks drive_connected)
 *
 * All via fetch (Pages Functions run on the same Workers runtime).
 *
 * Path A design: the Drive authorization is a DIRECT OAuth call from our code to
 * Google (separate from the Supabase login), so we control the refresh-token
 * capture. That means requesting access_type=offline and prompt=consent, which
 * is what guarantees Google returns a refresh token.
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;   // secret — bypasses RLS, writes Vault
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;        // secret
  ONBOARDING_BASE_URL: string;         // e.g. http://localhost:8788 or https://kenva.app
  MCP_URL: string;                     // the MCP endpoint users add in Claude
  TRIAL_DAYS?: string;                 // trial length; defaults to 35 (~5 weeks)
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** The redirect URI Google sends the user back to after Drive consent. */
export function driveRedirectUri(env: Env): string {
  return `${env.ONBOARDING_BASE_URL.replace(/\/$/, "")}/oauth/callback`;
}

/**
 * Build the Google consent URL for the Drive authorization step.
 * `state` carries the Supabase user id (so the callback knows who this is),
 * signed/opaque — here we pass it through and validate on return.
 */
export function buildDriveConsentUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: driveRedirectUri(env),
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",     // <-- makes Google return a refresh token
    prompt: "consent",          // <-- forces the consent screen so a refresh token is always issued
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/** Exchange the authorization code for tokens (incl. the refresh token). */
export async function exchangeCodeForTokens(env: Env, code: string): Promise<{
  access_token: string; refresh_token?: string; expires_in: number;
}> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: driveRedirectUri(env),
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Service-role headers for Supabase REST/RPC. */
function adminHeaders(env: Env, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

/**
 * Validate a Supabase access token (from the login step) and return the user id.
 * We call Supabase's /auth/v1/user endpoint with the user's token — simplest
 * reliable way to confirm identity on the server side here.
 */
export async function getUserIdFromToken(env: Env, userAccessToken: string): Promise<string> {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${userAccessToken}` },
  });
  if (!res.ok) throw new Error(`Could not resolve user from token: ${res.status}`);
  const user = await res.json() as { id?: string };
  if (!user.id) throw new Error("Token did not resolve to a user.");
  return user.id;
}

/**
 * Store (or replace) a Vault secret by name. Requires an upsert RPC in the DB
 * (migration 0003) callable only by the service role.
 */
export async function setVaultSecret(env: Env, name: string, secret: string): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/set_vault_secret`, {
    method: "POST",
    headers: adminHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ secret_name: name, secret_value: secret }),
  });
  if (!res.ok) throw new Error(`Vault write failed ${res.status}: ${await res.text()}`);
}

/** Create or update the user's account_state row: start trial, mark drive connected. */
export async function upsertAccountState(env: Env, userId: string): Promise<void> {
  const trialDays = parseInt(env.TRIAL_DAYS ?? "35", 10);
  const now = new Date();
  const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
  const row = {
    user_id: userId,
    status: "trial",
    trial_start: now.toISOString(),
    trial_end: trialEnd.toISOString(),
    drive_connected: true,
    updated_at: now.toISOString(),
  };
  // Upsert via PostgREST: POST with Prefer resolution=merge-duplicates.
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/account_state`, {
    method: "POST",
    headers: adminHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`account_state upsert failed ${res.status}: ${await res.text()}`);
}
