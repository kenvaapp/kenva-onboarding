# Kenva Onboarding

The onboarding web app: Google sign-in + Drive connect, on Cloudflare Pages.
It writes what the MCP server reads — the per-user Drive refresh token (to Vault)
and the account_state row (starts the trial).

**Status: foundation — works, unstyled. Visuals come later.**

## Flow (Path A)

1. User signs in with Google (Supabase Auth) — establishes identity.
2. User clicks "Connect Drive" — a direct OAuth call to Google for `drive.file`
   with `access_type=offline`, so Google returns a **refresh token**.
3. `/oauth/callback` exchanges the code, captures the refresh token, writes it to
   Vault as `drive_refresh_token:<user_id>`, and starts the trial.
4. Success page shows the MCP URL to add in Claude.

## Structure

```
public/index.html          landing page (sign in + connect)
functions/oauth/start.ts    /oauth/start  — redirects to Google Drive consent
functions/oauth/callback.ts /oauth/callback — captures refresh token -> Vault
functions/lib.ts            shared: OAuth, Vault writes, account_state
```

Cloudflare Pages maps `functions/oauth/callback.ts` to the URL `/oauth/callback`
automatically.

## SQL to run first (Supabase)

Run `0003_vault_write_rpc.sql` (service-role-only Vault WRITE RPC). You already
have `0001` (account_state) and `0002` (Vault read). Commit `0003` beside them.

## Local testing

1. Copy `.dev.vars.example` to `.dev.vars` and fill in real values (this file is
   gitignored — safe for secrets locally).
2. In `public/index.html`, the page needs your Supabase URL + anon key. For local
   dev, the simplest path: replace `REPLACE_SUPABASE_URL` and
   `REPLACE_SUPABASE_ANON_KEY` with your real values (both are public/safe).
3. Run the dev server:
   ```
   npm install
   npm run dev
   ```
   Wrangler serves it at `http://localhost:8788`.
4. Google + Supabase must allow the local URLs:
   - Google OAuth client → Authorized redirect URIs: add
     `http://localhost:8788/oauth/callback`
   - Supabase → Authentication → URL Configuration → Redirect URLs: add
     `http://localhost:8788/**` (and set Site URL to `http://localhost:8788`
     while testing)
5. Visit `http://localhost:8788`, sign in, connect Drive. On success you should
   see the "You're connected" page, and in Supabase a Vault secret named
   `drive_refresh_token:<your-user-id>` plus an `account_state` row.

## Deploy (later)

```
npm run deploy
```
Set the secrets in the Pages project settings (SUPABASE_SERVICE_ROLE_KEY,
GOOGLE_CLIENT_SECRET) rather than committing them. Point kenva.app at the Pages
project, and update ONBOARDING_BASE_URL + the Google redirect URI to the real
domain.
