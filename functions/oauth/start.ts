/**
 * /oauth/start — begins the Drive authorization (Path A, step 3).
 *
 * The signed-in user hits this with their Supabase access token (passed as a
 * query param or header from the page). We resolve their user id, then redirect
 * them to Google's consent screen for drive.file with offline access.
 *
 * The user id is carried in `state` so the callback knows who is returning.
 */

import { buildDriveConsentUrl, getUserIdFromToken, type Env } from "../lib.js";

interface Ctx { request: Request; env: Env; }

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const userToken = url.searchParams.get("token");

  if (!userToken) {
    return new Response("Missing login token. Please sign in first.", { status: 400 });
  }

  let userId: string;
  try {
    userId = await getUserIdFromToken(env, userToken);
  } catch (e) {
    return new Response(`Could not verify your login: ${e instanceof Error ? e.message : e}`, { status: 401 });
  }

  // state carries the user id back to the callback. (For production, sign this;
  // for the foundation it's an opaque pass-through we validate on return.)
  const consentUrl = buildDriveConsentUrl(env, userId);
  return Response.redirect(consentUrl, 302);
}
