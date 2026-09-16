/**
 * Server-only session helpers.
 *
 * The session is the set of Cognito tokens stored in httpOnly cookies. Pages
 * and Server Actions must go through `verifySession()`, which cryptographically
 * verifies the id token against the user pool's JWKS on every render pass.
 *
 * The `server-only` import below makes an accidental Client Component import a
 * build error rather than a leaked token.
 */
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { decomposeUnverifiedJwt } from "aws-jwt-verify/jwt";
import {
  JwtExpiredError,
  JwtInvalidClaimError,
  JwtInvalidSignatureAlgorithmError,
  JwtInvalidSignatureError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
  ParameterValidationError,
} from "aws-jwt-verify/error";
import { getCognitoConfig } from "./config";
import {
  ACCESS_TOKEN_COOKIE,
  AUTH_COOKIE_PATH,
  ID_TOKEN_COOKIE,
  IDLE_TIMEOUT_SECONDS,
  REFRESH_PROOF_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SESSION_COOKIES,
  SESSION_MARKER_COOKIE,
} from "./cookies";
import type { SignInTokens } from "./cognito";

/**
 * How long before the JWT's own expiry the id/access cookies are dropped by the
 * browser. Letting the cookie outlive the token would leave the session in a
 * state nothing can act on: the proxy sees a cookie and lets the request in,
 * then verification fails at render time. Expiring the cookie first makes
 * "no cookie" the single signal that a refresh is due.
 */
const COOKIE_EXPIRY_SKEW = 60; // seconds

/** Floor for every cookie lifetime: a cookie worth setting is worth a minute. */
const MIN_COOKIE_MAX_AGE = 60; // seconds

export interface Session {
  userId: string;
  email: string | null;
  name: string | null;
  /**
   * The id token's `exp`, in epoch seconds. Handed to the browser's
   * `SessionKeepalive` so it can refresh a minute or so before the token runs
   * out instead of waiting for a request to fail.
   */
  expiresAt: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function baseCookieOptions(path: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path,
  };
}

/**
 * The `exp` claim of a token we just received, in epoch seconds, or `null`.
 *
 * Decoded, not verified: it arrived over TLS in the response body of the
 * sign-in or refresh call we just made, and it is only used to decide how long
 * a cookie should live. A tampered value could not extend a session — the token
 * itself is verified on every request — so a decoding quirk must never cost
 * anyone their session, which is why this returns `null` instead of throwing.
 */
function tokenExpiry(token: string): number | null {
  try {
    const { payload } = decomposeUnverifiedJwt(token);
    const exp = payload.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch (error) {
    console.error("[auth] Could not read a token's expiry:", error);
    return null;
  }
}

/**
 * Cookie lifetime for a token cookie: its own expiry, less the skew.
 *
 * Each token gets its *own* `exp`, never the response's `ExpiresIn` — that
 * field describes the access token, and once the pool moves to a 5-minute id
 * token and a 15-minute access token the two differ by a factor of three.
 * `ExpiresIn` stays as the fallback for a token with no numeric `exp`.
 */
function tokenCookieMaxAge(expiry: number | null, expiresIn: number): number {
  const remaining = expiry === null ? expiresIn : expiry - nowSeconds();
  return Math.max(MIN_COOKIE_MAX_AGE, Math.floor(remaining - COOKIE_EXPIRY_SKEW));
}

/**
 * Cookie lifetime for the marker, refresh and proof cookies: the id token's
 * remaining life plus the whole idle window.
 *
 * This is the sliding session made out of nothing but a cookie attribute. Every
 * refresh re-dates all three, so an operator who keeps working keeps the
 * refresh token; a browser left alone drops it by itself
 * {@link IDLE_TIMEOUT_SECONDS} after the last id token it was given. The server
 * enforces the same window independently (see `refreshSession()`), because a
 * cookie lifetime is a request the browser is free to ignore.
 */
function idleWindowMaxAge(expiry: number | null, expiresIn: number): number {
  const remaining = expiry === null ? expiresIn : expiry - nowSeconds();
  return Math.max(
    MIN_COOKIE_MAX_AGE,
    Math.floor(remaining) + IDLE_TIMEOUT_SECONDS,
  );
}

/**
 * Stores the Cognito tokens in httpOnly cookies.
 * Must be called from a Server Action or Route Handler.
 *
 * Sets five cookies across two paths (see `./cookies`). The id and access
 * cookies expire {@link COOKIE_EXPIRY_SKEW} seconds before the JWTs they carry,
 * each from its own `exp`; the marker, the refresh token and the proof of
 * activity expire {@link IDLE_TIMEOUT_SECONDS} *after* the id token, which is
 * what makes the session slide forward for as long as someone is working.
 *
 * `currentRefreshToken` is the token already on file, and it matters when
 * refresh-token rotation is off: Cognito then returns no new refresh token, and
 * without passing the old one back in, the three sliding cookies could not be
 * re-dated and the session would end at a fixed time no matter how busy the
 * operator was. Pass it from the refresh path; sign-in has no need for it.
 */
export async function createSession(
  tokens: SignInTokens,
  currentRefreshToken?: string,
): Promise<void> {
  const cookieStore = await cookies();
  const rootOptions = baseCookieOptions("/");
  const idExpiry = tokenExpiry(tokens.idToken);

  cookieStore.set(ID_TOKEN_COOKIE, tokens.idToken, {
    ...rootOptions,
    maxAge: tokenCookieMaxAge(idExpiry, tokens.expiresIn),
  });
  cookieStore.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...rootOptions,
    maxAge: tokenCookieMaxAge(tokenExpiry(tokens.accessToken), tokens.expiresIn),
  });

  // Rotation on: a new refresh token. Rotation off: the one we were handed.
  const refreshToken = tokens.refreshToken ?? currentRefreshToken;
  if (!refreshToken) {
    return;
  }

  // The marker, the refresh token and the proof are always written together,
  // with the same lifetime, so the marker can never claim a refresh token that
  // is gone and the proof can never be missing while the token is there.
  const sessionMaxAge = idleWindowMaxAge(idExpiry, tokens.expiresIn);
  cookieStore.set(SESSION_MARKER_COOKIE, "1", {
    ...rootOptions,
    maxAge: sessionMaxAge,
  });
  const authOptions = baseCookieOptions(AUTH_COOKIE_PATH);
  cookieStore.set(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...authOptions,
    maxAge: sessionMaxAge,
  });
  cookieStore.set(REFRESH_PROOF_COOKIE, tokens.idToken, {
    ...authOptions,
    maxAge: sessionMaxAge,
  });
}

/**
 * Removes every session cookie, each at the path it was set on — a delete only
 * matches an exact name/path pair, so the paths must be spelled out.
 * Must be called from a Server Action or Route Handler.
 */
export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  for (const { name, path } of SESSION_COOKIES) {
    cookieStore.delete({ name, path });
  }
}

/**
 * Removes the path-`/` session cookies: the id token, the access token and the
 * marker. The `/api/auth`-scoped refresh cookies are left alone.
 *
 * Used by `GET /api/auth/refresh` when there is nothing to refresh with: the
 * marker is what makes the proxy send a protected page here, so leaving a stale
 * one behind would loop the browser through this endpoint to /login on every
 * navigation. Clearing only the page cookies keeps that self-healing free of
 * any risk to a refresh token that may still be perfectly good.
 *
 * Must be called from a Server Action or Route Handler.
 */
export async function clearPageSession(): Promise<void> {
  const cookieStore = await cookies();
  for (const { name, path } of SESSION_COOKIES) {
    if (path === "/") {
      cookieStore.delete({ name, path });
    }
  }
}

type Verifier = ReturnType<
  typeof CognitoJwtVerifier.create<{
    userPoolId: string;
    tokenUse: "id";
    clientId: string;
  }>
>;

let cachedVerifier: { key: string; verifier: Verifier } | null = null;

function getVerifier(): Verifier {
  const { userPoolId, clientId } = getCognitoConfig();
  const key = `${userPoolId}:${clientId}`;
  if (cachedVerifier?.key !== key) {
    cachedVerifier = {
      key,
      // Caches the pool's JWKS in memory across requests.
      verifier: CognitoJwtVerifier.create({
        userPoolId,
        tokenUse: "id",
        clientId,
      }),
    };
  }
  return cachedVerifier.verifier;
}

/**
 * True when the failure is a verdict about the token itself (malformed,
 * expired, wrong signature, wrong pool/client) rather than an infrastructure
 * problem. Only these justify treating the session as gone.
 *
 * `JwtInvalidClaimError` covers exp/nbf/iss/aud/token_use/client_id.
 * `JwtWithoutValidKidError` and `KidNotFoundInJwksError` mean the token points
 * at a key this pool does not publish, which is also a token-level verdict.
 * Everything else (JWKS fetch/transport failures, JWKS parse errors, the
 * refetch rate limiter, missing configuration) is transient or operational.
 */
function isInvalidTokenError(error: unknown): boolean {
  // aws-jwt-verify registers two issuer formats per user pool, so a token
  // whose `iss` is missing or names neither of them is reported as a
  // parameter problem ("issuer must be provided" / "issuer not configured:
  // ...") rather than a claim failure. It is still a verdict about the token.
  if (error instanceof ParameterValidationError) {
    return /^issuer (must be provided|not configured)/.test(error.message);
  }
  return (
    error instanceof JwtInvalidClaimError ||
    error instanceof JwtInvalidSignatureError ||
    error instanceof JwtInvalidSignatureAlgorithmError ||
    error instanceof JwtParseError ||
    error instanceof JwtWithoutValidKidError ||
    error instanceof KidNotFoundInJwksError
  );
}

/** Turns a verified id-token payload into the session the app passes around. */
function sessionFrom(payload: Awaited<ReturnType<Verifier["verify"]>>): Session | null {
  if (typeof payload.sub !== "string" || payload.sub === "") {
    return null;
  }
  const givenName = payload.given_name;
  const name = payload.name;
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    name:
      typeof givenName === "string" && givenName !== ""
        ? givenName
        : typeof name === "string" && name !== ""
          ? name
          : null,
    // Cognito always sets `exp`; the fallback only keeps the type honest and
    // makes a token without one look expired rather than eternal.
    expiresAt: typeof payload.exp === "number" ? payload.exp : nowSeconds(),
  };
}

/**
 * Verifies one Cognito id token (signature, issuer, audience, token_use, exp)
 * and returns the identity it carries, or `null` when the token is not valid.
 *
 * Token-agnostic about where the token came from, so both the cookie session
 * (`verifySession()`) and the API's `Authorization: Bearer` path can share it.
 *
 * @throws when verification could not be performed at all (for example the
 * user pool's JWKS endpoint is unreachable). Callers must not treat that as a
 * signed-out user: doing so would sign people out — and drop the refresh
 * cookie — on a transient network blip.
 */
export async function verifyIdToken(token: string): Promise<Session | null> {
  try {
    return sessionFrom(await getVerifier().verify(token));
  } catch (error) {
    if (isInvalidTokenError(error)) {
      // Expired, tampered with, or issued by a different pool/client. Log the
      // verdict only: aws-jwt-verify attaches the decoded token (`rawJwt`,
      // including sub/email) to these errors, and this path is reachable by
      // anonymous API callers presenting arbitrary bearer tokens.
      const reason =
        error instanceof Error ? `${error.name}: ${error.message}` : error;
      console.error("[auth] Session verification failed:", reason);
      return null;
    }
    // The token was never judged: the pool is unreachable, its JWKS could not
    // be parsed, or Cognito is not configured. Surface it instead of silently
    // destroying a session that may well still be valid.
    console.error("[auth] Session verification unavailable:", error);
    throw error;
  }
}

/**
 * Verifies an id token that is *allowed to have expired*, up to `graceSeconds`
 * ago. Everything else about it — signature, issuer, audience, token_use,
 * client id — still has to be right.
 *
 * This is how the idle window is judged (see `refreshSession()`): the id token
 * kept in the proof cookie can only ever have been issued to an active browser,
 * so "its `exp` is less than half an hour old" is a statement about when this
 * browser was last given a session, signed by Cognito and unforgeable here.
 *
 * `null` means the token is too old, malformed or not ours — a verdict. As in
 * {@link verifyIdToken}, a failure to reach the JWKS endpoint throws instead,
 * so an outage never reads as "idle".
 *
 * The two verdicts are logged differently on purpose. A proof that is merely
 * expired past the grace is the policy working — someone stopped working half
 * an hour ago — and gets one `info` line; anything else (bad signature, wrong
 * pool, malformed) is `error`, because it means a cookie jar that should not
 * exist. Neither line carries token content: aws-jwt-verify attaches the
 * decoded token, sub and email included, to these errors.
 *
 * @throws when verification could not be performed at all.
 */
export async function verifyRecentIdToken(
  token: string,
  graceSeconds: number,
): Promise<Session | null> {
  try {
    return sessionFrom(await getVerifier().verify(token, { graceSeconds }));
  } catch (error) {
    if (error instanceof JwtExpiredError) {
      console.info(
        `[auth] Proof of activity expired more than ${graceSeconds} seconds ago: the session was idle.`,
      );
      return null;
    }
    if (isInvalidTokenError(error)) {
      const reason =
        error instanceof Error ? `${error.name}: ${error.message}` : error;
      console.error("[auth] Proof-of-activity token rejected:", reason);
      return null;
    }
    console.error("[auth] Proof-of-activity verification unavailable:", error);
    throw error;
  }
}

/**
 * Verifies the id token cookie and returns the identity it carries, or `null`
 * when there is no valid session. Memoised per render pass with React `cache`.
 *
 * @throws when verification could not be performed at all — see
 * {@link verifyIdToken}.
 */
export const verifySession = cache(async (): Promise<Session | null> => {
  const token = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!token) {
    return null;
  }
  return verifyIdToken(token);
});
