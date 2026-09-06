/**
 * `/api/auth/refresh` — exchanges the refresh-token cookie for a new session.
 *
 * Public in `PUBLIC_API_PATHS` (there is by definition no valid id token when
 * this is called), but not unauthenticated: the refresh cookie *is* the
 * credential. It is scoped to `/api/auth`, so it only ever reaches this route.
 *
 * Two entry points for two kinds of caller:
 *
 * - `POST` — for fetch clients (see `src/lib/api/client.ts`). Answers with the
 *   `{ data }` envelope; the caller retries its original request afterwards.
 * - `GET ?next=/path` — for browser navigations. The proxy sends a page request
 *   here when the id cookie has expired but the session marker is still there,
 *   and this redirects back to `next` once the cookies have been rewritten.
 *
 * A `Bearer` token is never accepted as a substitute: a caller holding its own
 * token manages its own refresh.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  ApiError,
  isTooManyRequestsError,
  ServiceUnavailableError,
} from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { NEXT_PARAM, REFRESH_PATH } from "@/lib/auth/cookies";
import { refreshSession } from "@/lib/auth/refresh";
import { clearPageSession } from "@/lib/auth/session";
import { clientIp, ipRateLimitKey } from "@/lib/security/client-ip";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";

/**
 * Tighter than the default `api` budget: each call here spends a Cognito
 * request, and a legitimate client needs at most one per token lifetime.
 *
 * POST only. The GET is a browser navigation and enforces the same policy by
 * hand, because the wrapper's refusal is a JSON 429 — a page of JSON is not
 * something to hand a person who clicked a link. See {@link GET}.
 */
const POST_OPTIONS = { rateLimit: RATE_LIMITS.authRefresh, endpoint: "auth.refresh.post" };

/** The GET opts out of the wrapper's limiting and does it itself. */
const GET_OPTIONS = { rateLimit: null, endpoint: "auth.refresh.get" };

const LOGIN_PATH = "/login";

/** Long enough for any real in-app URL, short enough to bound the work. */
const MAX_NEXT_LENGTH = 512;

/** ASCII control characters, CR and LF among them, have no place in a path. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Reduces `?next=` to a safe same-origin path, defaulting to "/".
 *
 * Everything that could leave this origin is rejected rather than repaired:
 * absolute URLs, protocol-relative `//host` and its `/\host` variant (browsers
 * normalise the backslash to a slash), and control characters such as CR/LF.
 * `/api/...` is refused too — it is never a page, and refusing it is also what
 * makes it impossible for this endpoint to redirect to itself.
 */
function safeNextPath(raw: string | null): string {
  if (!raw || raw.length > MAX_NEXT_LENGTH) {
    return "/";
  }
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return "/";
  }
  // Backslashes never appear in a legitimate path here, and several browsers
  // treat them as slashes, which would turn "/\evil.com" into "//evil.com".
  if (raw.includes("\\")) {
    return "/";
  }
  if (hasControlCharacters(raw)) {
    return "/";
  }
  if (raw === "/api" || raw.startsWith("/api/")) {
    return "/";
  }
  return raw;
}

/**
 * POST /api/auth/refresh — refresh for fetch clients.
 *
 * 200 with the new lifetime and the caller's identity; 401 `refresh_failed`
 * when there is nothing left to refresh with (send the user to /login); 503
 * `auth_unavailable` when Cognito could not answer — a retry may well succeed,
 * and the session cookies are still intact.
 */
export const POST = apiHandler(async () => {
  const outcome = await refreshSession();

  switch (outcome.status) {
    case "refreshed":
      return ok({
        expiresIn: outcome.expiresIn,
        userId: outcome.session.userId,
        email: outcome.session.email,
      });
    case "no_refresh_token":
    case "invalid":
      // Cookies are cleared by `refreshSession` on "invalid" only — it saw
      // Cognito reject the token. "no_refresh_token" deliberately clears
      // nothing, and this is where the two methods differ: `sameSite: "lax"`
      // means a forged cross-site POST arrives without the refresh cookie and
      // would land in exactly this branch, and answering it with a pile of
      // deletions would hand any site on the web a one-request forced sign-out.
      // A fetch client has an answer to act on anyway; the GET below has only a
      // redirect, so it clears the stale marker instead of looping.
      throw new ApiError(401, "refresh_failed", "Sign in again.");
    case "unavailable":
      throw new ServiceUnavailableError(
        "auth_unavailable",
        "Authentication is temporarily unavailable. Please retry.",
      );
  }
}, POST_OPTIONS);

/**
 * GET /api/auth/refresh?next=/path — refresh for browser navigations.
 *
 * Always answers 303, so the browser lands on a real page: back to `next` on
 * success, on /login when the session is genuinely over. A Cognito outage also
 * lands on /login but keeps every cookie, because destroying a valid 30-day
 * refresh token over a transient failure is the one unrecoverable mistake here.
 *
 * `rateLimit: null` and the policy enforced inline below, for the same reason:
 * the wrapper would answer a 429 with a JSON error envelope, and the caller
 * here is a browser that was navigating to a page. It gets a redirect instead.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const toLogin = NextResponse.redirect(
    new URL(LOGIN_PATH, request.nextUrl.origin),
    303,
  );

  const rateLimitKey = ipRateLimitKey("ip:", clientIp(request));
  if (rateLimitKey) {
    try {
      await enforceRateLimit(rateLimitKey, RATE_LIMITS.authRefresh);
    } catch (error) {
      if (!isTooManyRequestsError(error)) {
        throw error;
      }
      // Nothing has been spent and no cookie is touched: the browser lands on
      // /login, and a session that is merely over budget is still intact for
      // the next attempt.
      return toLogin;
    }
  }

  // Validated before use: the origin comes from `nextUrl`, never from a Host
  // header the caller controls.
  const next = safeNextPath(request.nextUrl.searchParams.get(NEXT_PARAM));
  const outcome = await refreshSession();

  if (outcome.status === "refreshed") {
    return NextResponse.redirect(new URL(next, request.nextUrl.origin), 303);
  }

  if (outcome.status === "unavailable") {
    console.error(
      `[api] GET ${REFRESH_PATH} could not reach Cognito; session kept.`,
    );
    return toLogin;
  }

  // "no_refresh_token" or "invalid": there is nothing to come back to.
  //
  // Unlike the POST branch, this one does clear the page cookies. The marker at
  // path "/" is what makes the proxy send a protected page here; if it outlives
  // the refresh cookie — an old session from before the two were written
  // together, or a cookie jar that lost one of them — every navigation would
  // bounce through this endpoint to /login forever. Dropping the marker heals
  // that in one round trip. (On "invalid" `refreshSession` has already cleared
  // everything; deleting an absent cookie is a no-op.)
  //
  // Safe to do here where it is not in the POST: this is a top-level navigation
  // guarded by `Sec-Fetch-Site`, so a cross-site page cannot use it to force a
  // sign-out. A request with no such header is a non-browser client, which has
  // no ambient cookie to abuse in the first place.
  if (request.headers.get("sec-fetch-site") !== "cross-site") {
    await clearPageSession();
  }
  return toLogin;
}, GET_OPTIONS);
