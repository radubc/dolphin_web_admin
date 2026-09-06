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
  REFRESH_TOKEN_COOKIE,
  REFRESH_USER_COOKIE,
  SESSION_COOKIES,
  SESSION_MARKER_COOKIE,
} from "./cookies";
import type { SignInTokens } from "./cognito";

const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

/**
 * How long before the JWT's own expiry the id/access cookies are dropped by the
 * browser. Letting the cookie outlive the token would leave the session in a
 * state nothing can act on: the proxy sees a cookie and lets the request in,
 * then verification fails at render time. Expiring the cookie first makes
 * "no cookie" the single signal that a refresh is due.
 */
const COOKIE_EXPIRY_SKEW = 60; // seconds

export interface Session {
  userId: string;
  email: string | null;
  name: string | null;
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
 * The username Cognito expects alongside a refresh token.
 *
 * **The one place this is decided.** For REFRESH_TOKEN_AUTH, Cognito validates
 * the SECRET_HASH against the *pool username*, which the id token carries as
 * `cognito:username` — not against the address typed at sign-in. In a pool with
 * email aliases that value equals `sub`, which is why `sub` alone worked; in a
 * pool where people pick their own usernames the two differ and only
 * `cognito:username` is accepted. `sub` stays as the fallback for a token that
 * somehow lacks the claim.
 *
 * The token is decoded, not verified: it arrived over TLS in the response body
 * of the sign-in or refresh call we just made, and the value is only ever used
 * as an opaque input to an HMAC that Cognito itself re-checks. Returns `null`
 * for anything unparseable rather than throwing, so a session is never lost to
 * a decoding quirk.
 */
export function refreshUsernameFrom(idToken: string): string | null {
  try {
    const { payload } = decomposeUnverifiedJwt(idToken);
    const username = payload["cognito:username"];
    if (typeof username === "string" && username !== "") {
      return username;
    }
    const sub = payload.sub;
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch (error) {
    console.error("[auth] Could not read the id token username:", error);
    return null;
  }
}

/**
 * Stores the Cognito tokens in httpOnly cookies.
 * Must be called from a Server Action or Route Handler.
 *
 * Sets up to five cookies across two paths (see `./cookies`). The id and access
 * cookies expire {@link COOKIE_EXPIRY_SKEW} seconds before the JWTs they carry.
 *
 * When `tokens.refreshToken` is undefined the refresh-scoped cookies are left
 * exactly as they are: Cognito omits the refresh token from a REFRESH_TOKEN_AUTH
 * response unless rotation is enabled, and the existing one must keep working.
 * The marker is left alone in that case too, and deliberately so — it is set
 * only together with a refresh token, so its 30 days always describe the token
 * that is actually on file. Sliding it on every refresh would let the marker
 * outlive the refresh cookie, and the proxy would then bounce every protected
 * GET through the refresh endpoint to /login for as long as the marker lasted.
 */
export async function createSession(tokens: SignInTokens): Promise<void> {
  const cookieStore = await cookies();
  const rootOptions = baseCookieOptions("/");
  const tokenMaxAge = Math.max(60, tokens.expiresIn - COOKIE_EXPIRY_SKEW);

  cookieStore.set(ID_TOKEN_COOKIE, tokens.idToken, {
    ...rootOptions,
    maxAge: tokenMaxAge,
  });
  cookieStore.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...rootOptions,
    maxAge: tokenMaxAge,
  });

  if (tokens.refreshToken) {
    // The marker and the refresh token are written together, with the same
    // lifetime, so the marker can never claim a refresh token that is gone.
    cookieStore.set(SESSION_MARKER_COOKIE, "1", {
      ...rootOptions,
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });
    const authOptions = baseCookieOptions(AUTH_COOKIE_PATH);
    cookieStore.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      ...authOptions,
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });
    const username = refreshUsernameFrom(tokens.idToken);
    if (username) {
      cookieStore.set(REFRESH_USER_COOKIE, username, {
        ...authOptions,
        maxAge: REFRESH_TOKEN_MAX_AGE,
      });
    }
  }
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

/**
 * Verifies one Cognito id token (signature, issuer, audience, token_use, exp)
 * and returns the identity it carries, or `null` when the token is not valid.
 *
 * Token-agnostic about where the token came from, so both the cookie session
 * (`verifySession()`) and the API's `Authorization: Bearer` path can share it.
 *
 * @throws when verification could not be performed at all (for example the
 * user pool's JWKS endpoint is unreachable). Callers must not treat that as a
 * signed-out user: doing so would sign people out — and drop the 30-day
 * refresh cookie — on a transient network blip.
 */
export async function verifyIdToken(token: string): Promise<Session | null> {
  try {
    const payload = await getVerifier().verify(token);
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
    };
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
