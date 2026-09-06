/**
 * `/api/auth/logout` — ends the session and revokes the refresh token.
 *
 * This lives under `/api/auth` for one reason: the refresh-token cookie is
 * scoped to that path, so this is the only place in the app that can read it
 * and hand it to Cognito's RevokeToken. Everything that signs a user out has to
 * come through here, and it has to *arrive* here as a real request from the
 * browser: the sign-out control on a page is a plain HTML form posting to this
 * path (see `src/app/page.tsx`), not a Server Action, because an action's
 * `redirect()` is followed server-side using the original POST's cookies — the
 * path-scoped refresh token would never be sent and nothing would be revoked.
 *
 * Three shapes of caller, all handled:
 *
 * - a form POST (a navigation) — 303 to /login;
 * - a `fetch` POST — 204, no body, for a Client Component to act on;
 * - a GET navigation — 303 to /login, for the JS-free path and typed URLs.
 *
 * Public in `PUBLIC_API_PATHS`: signing out must work even when the id token
 * has already expired.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { noContent } from "@/lib/api/response";
import { revokeRefreshToken } from "@/lib/auth/cognito";
import { REFRESH_TOKEN_COOKIE } from "@/lib/auth/cookies";
import { clearSession } from "@/lib/auth/session";
import { RATE_LIMITS } from "@/lib/security/rate-limit";

/** Same budget as refresh: both spend a Cognito call per request. */
const HANDLER_OPTIONS = { rateLimit: RATE_LIMITS.authRefresh };

const LOGIN_PATH = "/login";

/**
 * Whether this request is a browser navigating here (a form submission or a
 * typed URL) rather than a script's `fetch`.
 *
 * `Sec-Fetch-Mode` is set by the browser and cannot be forged by page script,
 * so it is the first choice. A client old enough not to send it is judged by
 * `Accept`: a navigation asks for HTML, `apiFetch` asks for JSON.
 */
function isNavigation(request: NextRequest): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) {
    return mode === "navigate";
  }
  return request.headers.get("accept")?.includes("text/html") ?? false;
}

/**
 * Whether the request came from this site.
 *
 * `Sec-Fetch-Site` is browser-set and unforgeable by page script, so when it is
 * there it decides: only `same-origin` (our own page or form) and `none` (a
 * typed URL or a bookmark) may proceed. A request without the header is a
 * non-browser client, which carries no ambient cookie to abuse.
 */
function isSameSite(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!fetchSite) {
    return true;
  }
  return fetchSite === "same-origin" || fetchSite === "none";
}

/**
 * Revokes the refresh token, if one reached us, and clears every cookie.
 *
 * Revocation is best effort — `revokeRefreshToken` swallows its own failures —
 * because a user who clicked "Sign out" must end up signed out of this browser
 * whatever Cognito says. Clearing the cookies is the part that always happens.
 */
async function endSession(request: NextRequest): Promise<void> {
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
  await clearSession();
}

/** 303 so the browser follows up with a GET, whatever the method used here. */
function redirectTo(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.nextUrl.origin), 303);
}

/**
 * Signing out is destructive but not dangerous — the worst a forged request can
 * do is sign the victim out, and it can read nothing back. It is still refused:
 * a cross-site caller gets sent to "/" (navigations) or a 403 (fetch), and no
 * cookie is touched.
 */
function rejectCrossSite(
  request: NextRequest,
  navigation: boolean,
): NextResponse {
  if (navigation) {
    return redirectTo(request, "/");
  }
  throw new ApiError(403, "csrf_rejected", "Cross-site request rejected.");
}

/**
 * GET /api/auth/logout — sign-out as a browser navigation, ending on /login.
 *
 * Kept alongside the POST for the JS-free path (a typed URL, a bookmark) and
 * because `logout()` in `src/lib/auth/actions.ts` used to redirect here.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  if (!isSameSite(request)) {
    return rejectCrossSite(request, true);
  }
  await endSession(request);
  return redirectTo(request, LOGIN_PATH);
}, HANDLER_OPTIONS);

/**
 * POST /api/auth/logout — the sign-out form, and fetch clients.
 *
 * A form submission is a navigation and must end on a page, so it gets a 303 to
 * /login; a `fetch` gets 204 and decides for itself where to go next.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const navigation = isNavigation(request);
  if (!isSameSite(request)) {
    return rejectCrossSite(request, navigation);
  }
  await endSession(request);
  return navigation ? redirectTo(request, LOGIN_PATH) : noContent();
}, HANDLER_OPTIONS);
