/**
 * Session cookie names, paths and routing constants.
 *
 * Dependency-free on purpose: both the proxy (which must stay lightweight) and
 * the server-only session module import from here.
 *
 * The session is split across two cookie paths:
 *
 * - `/` — the short-lived id and access tokens plus a value-free marker. These
 *   travel with every request, which is what the proxy and the API read.
 * - `/api/auth` — the long-lived refresh token and the username it must be
 *   presented with. The refresh token is the most sensitive credential in the
 *   set (30 days, exchangeable for fresh tokens), so it is scoped to the only
 *   endpoints allowed to spend it. It is never sent to a page render, an API
 *   route, or any third-party subresource request.
 */

export const ID_TOKEN_COOKIE = "psa_id_token";
export const ACCESS_TOKEN_COOKIE = "psa_access_token";
export const REFRESH_TOKEN_COOKIE = "psa_refresh_token";

/**
 * Username Cognito needs alongside the refresh token when the app client has a
 * secret (the SECRET_HASH is computed over it). Stored next to the refresh
 * token because it is only ever needed there. Carries no credential.
 */
export const REFRESH_USER_COOKIE = "psa_refresh_user";

/**
 * Value-free marker ("1") telling the proxy that a refresh token exists. The
 * proxy runs at every path and therefore cannot see the `/api/auth`-scoped
 * refresh cookie, so without this it could not tell "signed out" from "signed
 * in, id token just expired".
 */
export const SESSION_MARKER_COOKIE = "psa_session";

/** Path the refresh-token cookies are scoped to. */
export const AUTH_COOKIE_PATH = "/api/auth";

/** Endpoint that exchanges the refresh token for a fresh session. */
export const REFRESH_PATH = `${AUTH_COOKIE_PATH}/refresh`;

/** Endpoint that revokes the refresh token and ends the session. */
export const LOGOUT_PATH = `${AUTH_COOKIE_PATH}/logout`;

/** Query parameter carrying the post-refresh destination. */
export const NEXT_PARAM = "next";

/** A cookie plus the path it was set on: deleting needs both to match. */
export interface SessionCookie {
  name: string;
  path: string;
}

/**
 * Every session cookie with its path, so logout and the proxy stay in sync.
 *
 * `psa_` prefix, not the consumer app's `ps_`: browsers do not scope cookies by
 * port, so on localhost both apps share one jar and identical names would let
 * one app's session overwrite the other's.
 */
export const SESSION_COOKIES: readonly SessionCookie[] = [
  { name: ID_TOKEN_COOKIE, path: "/" },
  { name: ACCESS_TOKEN_COOKIE, path: "/" },
  { name: SESSION_MARKER_COOKIE, path: "/" },
  { name: REFRESH_TOKEN_COOKIE, path: AUTH_COOKIE_PATH },
  { name: REFRESH_USER_COOKIE, path: AUTH_COOKIE_PATH },
];

/**
 * Query flag a protected page sets when it holds a session cookie that does not
 * verify. The proxy answers it by clearing the session cookies, which prevents
 * an endless "/" -> "/login" -> "/" bounce on a stale token.
 */
export const EXPIRED_SESSION_PARAM = "session";
export const EXPIRED_SESSION_VALUE = "expired";
export const EXPIRED_SESSION_REDIRECT = `/login?${EXPIRED_SESSION_PARAM}=${EXPIRED_SESSION_VALUE}`;
