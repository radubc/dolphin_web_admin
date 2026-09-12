import { NextResponse, type NextRequest } from "next/server";
import {
  EXPIRED_SESSION_PARAM,
  EXPIRED_SESSION_VALUE,
  ID_TOKEN_COOKIE,
  LOGOUT_PATH,
  NEXT_PARAM,
  REFRESH_PATH,
  SESSION_COOKIES,
  SESSION_MARKER_COOKIE,
} from "@/lib/auth/cookies";

/**
 * Optimistic auth routing only: this checks whether the id token cookie is
 * present, never what it contains. Real verification happens in
 * `verifySession()` (see `src/lib/auth/session.ts`), which every protected page
 * calls before rendering.
 */
const LOGIN_PATH = "/login";
const FORGOT_PASSWORD_PATH = "/forgot-password";

/**
 * Routes reachable without a session. Signed-in visitors are bounced from
 * these to "/", since none of them mean anything with a session in hand.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  LOGIN_PATH,
  FORGOT_PASSWORD_PATH,
]);

const API_PREFIX = "/api";

/**
 * API routes reachable without a credential. Everything else under `/api/` is
 * refused here unless the caller at least presents something that looks like
 * one; add a path here when a new endpoint is meant to be public.
 */
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  `${API_PREFIX}/health`,
  // Both carry their own credential in the path-scoped refresh cookie, and both
  // have to work precisely when the id token has expired.
  REFRESH_PATH,
  LOGOUT_PATH,
  // The machine endpoints: they authenticate with an `API_KEYS` entry sent as
  // `x-api-key`, which this proxy does not recognise as a credential. They are
  // "public" only in the sense that they get past here; `serviceHandler`
  // refuses every request that does not carry a valid key.
  `${API_PREFIX}/v1/service/quotes`,
  `${API_PREFIX}/v1/service/exchange-rates`,
  // The defaults the consumer app pulls when it creates a tenant (categories
  // and financial institutions are no longer pushed to the main database).
  `${API_PREFIX}/v1/service/defaults/categories`,
  `${API_PREFIX}/v1/service/defaults/financial-institutions`,
]);

/** Same character set `src/lib/api/handler.ts` accepts for an inbound request id. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~+/=@:-]{1,128}$/;

/**
 * API requests get a JSON 401, never a redirect to /login: an API client wants
 * a status code, not an HTML login page. Real verification still happens in the
 * handler (`protectedHandler`), so this is only a cheap early-out.
 */
function handleApiRequest(request: NextRequest, hasCredential: boolean) {
  if (PUBLIC_API_PATHS.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }
  // A CORS preflight carries no credentials by design; refusing it here would
  // block every cross-origin client before it could even send its token. Next
  // answers OPTIONS itself, and the actual request is still gated below.
  if (request.method === "OPTIONS") {
    return NextResponse.next();
  }
  if (hasCredential || request.headers.has("authorization")) {
    return NextResponse.next();
  }
  // Mirrors the `x-request-id` contract of `src/lib/api/handler.ts` (kept
  // separate on purpose: the proxy must stay dependency-light) so even a
  // proxy-level refusal can be found in the logs.
  const requestId = request.headers.get("x-request-id")?.trim();
  return NextResponse.json(
    { error: { code: "unauthorized", message: "Authentication required." } },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "x-request-id":
          requestId && SAFE_REQUEST_ID.test(requestId)
            ? requestId
            : crypto.randomUUID(),
      },
    },
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  const hasSessionCookie = request.cookies.has(ID_TOKEN_COOKIE);
  // Set for as long as a refresh token exists. The refresh token itself is
  // scoped to `/api/auth` and is invisible here, so this marker is what tells
  // "signed out" apart from "signed in, id token just expired".
  const hasSessionMarker = request.cookies.has(SESSION_MARKER_COOKIE);

  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    // The marker alone is enough to get past this gate: the handler answers a
    // stale session with `token_expired` so the client can refresh and retry.
    return handleApiRequest(request, hasSessionCookie || hasSessionMarker);
  }

  const isLoginRoute = pathname === LOGIN_PATH;
  const isPublicRoute = PUBLIC_PATHS.has(pathname);

  // A protected page found the cookie unusable: drop the stale cookies and
  // land on a clean /login instead of bouncing back to "/".
  if (
    isLoginRoute &&
    searchParams.get(EXPIRED_SESSION_PARAM) === EXPIRED_SESSION_VALUE
  ) {
    const response = NextResponse.redirect(
      new URL(LOGIN_PATH, request.nextUrl),
    );
    // Only clear when there really is a session to clear. Without this guard a
    // hand-typed or stale `?session=expired` link would delete the 30-day
    // refresh cookie of someone who is merely signed out of this browser tab.
    if (hasSessionCookie || hasSessionMarker) {
      for (const { name, path } of SESSION_COOKIES) {
        // Name and path both have to match, so each cookie is deleted at the
        // path it was set on.
        response.cookies.delete({ name, path });
      }
    }
    return response;
  }

  if (!hasSessionCookie && !isPublicRoute) {
    // The id cookie expires a minute before the token inside it, so this is the
    // normal end of an hour-long session rather than an error. With a refresh
    // token still on file, send the browser through the refresh endpoint and
    // back to where it was going. Only for GET: a POST cannot be replayed
    // across a redirect chain, so those keep going to /login as before.
    if (hasSessionMarker && request.method === "GET") {
      const target = new URL(REFRESH_PATH, request.nextUrl);
      target.searchParams.set(NEXT_PARAM, `${pathname}${search}`);
      return NextResponse.redirect(target, 307);
    }
    return NextResponse.redirect(new URL(LOGIN_PATH, request.nextUrl));
  }

  // Deliberately keyed on the id cookie, not the marker: someone with only a
  // refresh token who asks for /login gets /login. Signing in fresh is a
  // reasonable thing to want, and a refresh can still be triggered by any
  // protected page afterwards.
  if (hasSessionCookie && isPublicRoute) {
    return NextResponse.redirect(new URL("/", request.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals, brand/logo assets, and static files.
    "/((?!_next/static|_next/image|logos/|brand/|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|txt|xml|webmanifest)$).*)",
  ],
};
