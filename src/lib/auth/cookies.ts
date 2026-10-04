/**
 * Session cookie names, paths and routing constants.
 *
 * Dependency-free on purpose: both the proxy (which must stay lightweight) and
 * the server-only session module import from here, and so does the client
 * keepalive component — {@link IDLE_TIMEOUT_SECONDS} is one number the browser,
 * the proxy and the refresh endpoint all have to agree on.
 *
 * The session is split across two cookie paths:
 *
 * - `/` — the short-lived id and access tokens plus a value-free marker. These
 *   travel with every request, which is what the proxy and the API read.
 * - `/api/auth` — the refresh token and the proof of last activity. The refresh
 *   token is the most valuable credential in the set (it is exchangeable for
 *   fresh tokens), so it is scoped to the only endpoints allowed to spend it.
 *   It is never sent to a page render, an API route, or any third-party
 *   subresource request.
 */

/**
 * How long a browser may sit without any activity before its session is over.
 *
 * The session is a sliding window, not a fixed one: every refresh re-dates the
 * marker, refresh and proof cookies, so someone who keeps working is never
 * signed out, and someone who walks away is signed out half an hour later.
 * Cognito has no idle timeout of its own — a refresh token has a fixed absolute
 * validity and rotation does not extend it — so this window is entirely the
 * app's, enforced in three places that share this constant:
 *
 * - the browser, which drops the refresh cookie once it is this far past the
 *   last id token (see `createSession()`);
 * - `refreshSession()`, which refuses to spend a refresh token when the proof
 *   cookie's id token expired more than this long ago;
 * - the `SessionKeepalive` component, which signs out after this long without
 *   a pointer, key, wheel, touch, scroll or visibility event in any tab.
 */
export const IDLE_TIMEOUT_SECONDS = 30 * 60;

export const ID_TOKEN_COOKIE = "psa_id_token";
export const ACCESS_TOKEN_COOKIE = "psa_access_token";
export const REFRESH_TOKEN_COOKIE = "psa_refresh_token";

/**
 * Legacy: the username Cognito needed alongside the refresh token when the
 * `REFRESH_TOKEN_AUTH` flow computed a SECRET_HASH over it.
 *
 * **No longer written.** `GetTokensFromRefreshToken` takes the client secret
 * itself and needs no username, so nothing reads this any more. The constant
 * and its `SESSION_COOKIES` entry stay so that logout, the proxy's
 * `?session=expired` branch and `clearSession()` keep deleting the copies left
 * in the cookie jars of sessions created before that change.
 */
export const REFRESH_USER_COOKIE = "psa_refresh_user";

/**
 * The id token that was issued last, kept beside the refresh token as the
 * tamper-proof record of when this browser was last active.
 *
 * It is a credential-free use of a credential: the refresh endpoint verifies
 * it against the pool's JWKS with a {@link IDLE_TIMEOUT_SECONDS} grace, so a
 * token that expired longer ago than that means the session has been idle too
 * long. Cognito's signature is what makes it unforgeable, so the app needs no
 * secret of its own to keep an honest clock. Path-scoped to `/api/auth` like
 * the refresh token, and written with the same lifetime.
 */
export const REFRESH_PROOF_COOKIE = "psa_refresh_proof";

/**
 * Value-free marker ("1") telling the proxy that a refresh token exists. The
 * proxy runs at every path and therefore cannot see the `/api/auth`-scoped
 * refresh cookie, so without this it could not tell "signed out" from "signed
 * in, id token just expired".
 */
export const SESSION_MARKER_COOKIE = "psa_session";

/**
 * How this session was signed in: `password`, `password+totp` or `passkey`,
 * followed by an HMAC that ties the value to the id token's subject and
 * sign-in (`sub` + `origin_jti`), so a jar cannot be edited into a stronger
 * sign-in than it had. Written at sign-in, re-signed on every refresh, and
 * read by the one action that insists on a second factor (turning off a
 * customer's two-factor authentication). A session without it — minted
 * before the cookie existed — reads as `password`. Path `/`, same lifetime
 * as the marker.
 */
export const SIGN_IN_METHOD_COOKIE = "psa_sign_in_method";

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
  { name: SIGN_IN_METHOD_COOKIE, path: "/" },
  { name: REFRESH_TOKEN_COOKIE, path: AUTH_COOKIE_PATH },
  { name: REFRESH_PROOF_COOKIE, path: AUTH_COOKIE_PATH },
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

/**
 * The other value of the same query parameter: the session ended because the
 * browser was idle for {@link IDLE_TIMEOUT_SECONDS}. Set by the refresh
 * endpoint and by the keepalive component, and read only by `/login`, which
 * explains what happened.
 *
 * Deliberately *not* handled by the proxy the way `expired` is: by the time
 * this value is used the cookies have already been cleared by the server, so
 * there is nothing left to clean up and no bounce to break.
 */
export const IDLE_SESSION_VALUE = "idle";
export const IDLE_SESSION_REDIRECT = `/login?${EXPIRED_SESSION_PARAM}=${IDLE_SESSION_VALUE}`;
