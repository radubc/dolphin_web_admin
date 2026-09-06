import "server-only";
/**
 * Caller identification for Route Handlers.
 *
 * Two credential sources are accepted, in this order:
 *
 * 1. `Authorization: Bearer <cognito id token>` — for non-browser clients
 *    (scripts, a future mobile app) that hold the token themselves.
 * 2. The `psa_id_token` httpOnly cookie — for the browser app.
 *
 * Both end up in the same verifier as the page session, so there is exactly one
 * definition of "who is this" in the codebase.
 *
 * The two sources are not treated identically in one respect: a cookie is an
 * ambient credential the browser attaches to cross-site requests all by itself,
 * so cookie-authenticated writes additionally have to pass an origin check. A
 * bearer token has to be put there deliberately by the caller and is exempt.
 */
import type { NextRequest } from "next/server";
import { ID_TOKEN_COOKIE, SESSION_MARKER_COOKIE } from "@/lib/auth/cookies";
import { verifyIdToken, type Session } from "@/lib/auth/session";
import { trustProxyHeaders } from "@/lib/security/client-ip";
import { ApiError, ServiceUnavailableError, UnauthorizedError } from "./errors";

/** Methods that must not change state, and so need no CSRF defence. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Extracts the token from an `Authorization: Bearer <token>` header. */
function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }
  // A bearer credential is exactly one token; anything else is malformed.
  return rest.length === 1 ? rest[0] : null;
}

/**
 * The host the browser believes it is talking to.
 *
 * Behind a proxy that terminates TLS, `Host` is whatever that proxy forwards
 * (often an internal name or an IP), while the browser's `Origin` names the
 * public one — comparing the two would refuse every write. `X-Forwarded-Host`
 * carries the public name, and is believed on exactly the same terms as
 * `X-Forwarded-For`: only when `TRUST_PROXY_HEADERS` says our own edge wrote
 * it. Its first entry is the outermost (client-facing) host.
 */
function expectedHost(request: NextRequest): string {
  if (trustProxyHeaders()) {
    const forwarded = request.headers.get("x-forwarded-host");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first !== "") {
        return first;
      }
    }
  }
  // `host` is the value the request was actually addressed to; `nextUrl.host`
  // covers a runtime that strips the header.
  return request.headers.get("host") ?? request.nextUrl.host;
}

/**
 * Refuses a cookie-authenticated write that did not come from this site.
 *
 * The session cookie is `sameSite: "lax"`, which already blocks cross-site
 * POSTs from other pages; this is the second layer, and it is what makes the
 * first cookie-authenticated write endpoint safe to add.
 *
 * Two signals, in order of trustworthiness:
 *
 * - `Sec-Fetch-Site` is set by the browser itself and cannot be forged by page
 *   script. Anything other than `same-origin` (or `none`, meaning a user-typed
 *   URL or a bookmark) is refused.
 * - `Origin`, for the older clients that do not send `Sec-Fetch-Site`: its host
 *   must match the host the request was addressed to.
 *
 * A request with neither header is allowed through: that is a non-browser
 * client, which has no ambient cookie to abuse in the first place.
 */
function assertSameOrigin(request: NextRequest): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }

  const rejected = new ApiError(
    403,
    "csrf_rejected",
    "Cross-site request rejected.",
  );

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) {
    if (fetchSite !== "same-origin" && fetchSite !== "none") {
      throw rejected;
    }
    return;
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return;
  }
  const host = expectedHost(request);
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw rejected;
  }
  if (originHost !== host) {
    throw rejected;
  }
}

/**
 * Resolves the caller's identity, or refuses the request.
 *
 * @throws {ApiError} 403 `csrf_rejected` when a cookie-authenticated write
 * arrives from another origin.
 * @throws {ApiError} 401 `token_expired` when the browser session's id token
 * has run out but a refresh token is still on file. Clients switch on this
 * code, call `POST /api/auth/refresh`, and retry once — see
 * `src/lib/api/client.ts`.
 * @throws {UnauthorizedError} 401 when no credential was sent, or the token is
 * absent, malformed, expired, or issued by another pool/client.
 * @throws {ServiceUnavailableError} 503 when the token could not be judged at
 * all (JWKS unreachable, Cognito misconfigured). This deliberately does not
 * collapse into a 401: telling a client its credential is bad during an outage
 * would make it discard a perfectly good token and sign the user out.
 */
export async function authenticate(request: NextRequest): Promise<Session> {
  const bearer = bearerToken(request);
  const cookieToken = request.cookies.get(ID_TOKEN_COOKIE)?.value;
  // The marker outlives the id cookie by design: it is what says "this browser
  // still holds a refresh token", and it is the difference between "sign in"
  // and "refresh and retry".
  const canRefresh = request.cookies.has(SESSION_MARKER_COOKIE);
  const usingCookie = bearer === null && (cookieToken !== undefined || canRefresh);

  if (usingCookie) {
    assertSameOrigin(request);
  }

  const expired = new ApiError(
    401,
    "token_expired",
    "Session expired; refresh and retry.",
  );

  const token = bearer ?? cookieToken;
  if (!token) {
    if (usingCookie && canRefresh) {
      throw expired;
    }
    throw new UnauthorizedError("Authentication required.");
  }

  let session: Session | null;
  try {
    session = await verifyIdToken(token);
  } catch {
    // `verifyIdToken` has already logged the underlying cause.
    throw new ServiceUnavailableError(
      "auth_unavailable",
      "Authentication is temporarily unavailable. Please retry.",
    );
  }

  if (!session) {
    if (usingCookie && canRefresh) {
      throw expired;
    }
    throw new UnauthorizedError("Invalid or expired credentials.");
  }
  return session;
}
