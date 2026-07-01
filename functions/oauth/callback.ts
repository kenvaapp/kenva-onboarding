/**
 * /oauth/callback — the heart of onboarding (Path A, steps 4-6).
 *
 * Google redirects here after the user grants drive.file. We:
 *   1. read the authorization `code` and `state` (the user id)
 *   2. exchange the code for tokens — capturing the REFRESH TOKEN
 *   3. write the refresh token to Vault as drive_refresh_token:<user_id>
 *   4. upsert the account_state row (start trial, mark drive_connected)
 *   5. show a success page with the MCP URL for Claude
 *
 * This is the make-or-break step: if no refresh token comes back, we fail loud
 * rather than pretend success (a silent failure here means the user's Drive is
 * unreachable later and they'd never know why).
 */

import {
  exchangeCodeForTokens, setVaultSecret, upsertAccountState, type Env,
} from "../lib.js";

interface Ctx { request: Request; env: Env; }

function page(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; line-height: 1.6;">
${bodyHtml}
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const { request, env } = ctx;
  const url = new URL(request.url);

  // Google may redirect back with an error (user declined, etc.)
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return page("Connection cancelled",
      `<h1>Drive connection cancelled</h1>
       <p>You didn't finish connecting your Google Drive (${oauthError}). Kenva needs Drive access to store your contacts. You can try again from the start page.</p>`, 400);
  }

  const code = url.searchParams.get("code");
  const userId = url.searchParams.get("state"); // we put the user id in state
  if (!code || !userId) {
    return page("Something went wrong",
      `<h1>Missing information</h1><p>The connection response was incomplete. Please start over.</p>`, 400);
  }

  try {
    // 2. exchange code -> tokens
    const tokens = await exchangeCodeForTokens(env, code);

    // Make-or-break: we MUST get a refresh token, or Drive is unreachable later.
    if (!tokens.refresh_token) {
      return page("Couldn't complete setup",
        `<h1>Drive connection incomplete</h1>
         <p>Google didn't return the long-term access Kenva needs. This usually happens if you'd already granted access before. Please try again — if it keeps happening, remove Kenva from your Google account's connected apps and retry.</p>`, 502);
    }

    // 3. store the refresh token in Vault (per-user, encrypted)
    await setVaultSecret(env, `drive_refresh_token:${userId}`, tokens.refresh_token);

    // 4. start the trial / mark connected
    await upsertAccountState(env, userId);

    // 5. success
    return page("You're connected",
      `<h1>Kenva is connected 🎉</h1>
       <p>Your Google Drive is linked and your free trial has started. A <strong>Kenva Contacts</strong> folder will appear in your Drive the first time you add a contact.</p>
       <h2>Add Kenva to Claude</h2>
       <p>In Claude, add a custom connector with this URL:</p>
       <pre style="background:#f4f4f4;padding:12px;border-radius:8px;overflow:auto">${env.MCP_URL}</pre>
       <p>Then just talk to Claude naturally — "add a contact", "log that I had coffee with Nancy", and so on.</p>`);
  } catch (e) {
    return page("Setup error",
      `<h1>Something went wrong during setup</h1>
       <p>We couldn't finish connecting your account: ${e instanceof Error ? e.message : String(e)}</p>
       <p>Nothing was charged and no data was stored. Please try again.</p>`, 500);
  }
}
