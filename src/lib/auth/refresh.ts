import "server-only";
/**
 * Turning a refresh token into a fresh session.
 *
 * Nothing in this app calls AWS with the operator's tokens outside the Account
 * & security drawer, so the only thing that ever needs a refresh is our own
 * session: the id and access tokens are short-lived (minutes, once the pool is
 * updated) and the refresh token has a fixed absolute validity measured from
 * sign-in. `refreshSession()` spends the second to renew the first.
 *
 * It is also where the **idle window** is enforced. Cognito has no idle
 * timeout — a refresh token is valid until its absolute expiry, and rotation
 * does not extend it — so the policy "signed out after
 * `IDLE_TIMEOUT_SECONDS` without activity, never while working" is this
 * function's job. The proof cookie carries the id token issued last; a token
 * can only ever have been issued to a browser that was there, so
 * "its `exp` is less than the idle window old" is an honest, Cognito-signed
 * statement about when this browser was last active. Cookie lifetimes say the
 * same thing (see `createSession()`), but a cookie lifetime is a request the
 * browser is free to ignore — this check is the one that cannot be bypassed.
 *
 * **Must be called from a Route Handler or a Server Action.** It writes cookies,
 * which is impossible during render — that is also why `verifySession()` cannot
 * refresh on its own, and why an expired page session is renewed by bouncing the
 * browser through `GET /api/auth/refresh` (see `src/proxy.ts`).
 */
import { cookies } from "next/headers";
import {
  IDLE_TIMEOUT_SECONDS,
  REFRESH_PROOF_COOKIE,
  REFRESH_TOKEN_COOKIE,
  SIGN_IN_METHOD_COOKIE,
} from "./cookies";
import { refreshTokens, revokeRefreshToken } from "./cognito";
import { CognitoConfigError } from "./config";
import {
  clearSession,
  createSession,
  verifyIdToken,
  verifyRecentIdToken,
  type Session,
} from "./session";

/**
 * Why the proof of activity did not hold.
 *
 * - `stale` — the proof was there and expired more than the idle window ago:
 *   this browser really did sit idle, and the person should be told so.
 * - `missing` — there was no proof cookie at all. A session created before the
 *   cookie existed, or a jar that lost it. Nothing is known about activity, so
 *   the caller is sent to a plain sign-in page rather than told it was idle.
 */
export type IdleProof = "missing" | "stale";

export type RefreshOutcome =
  /** New tokens are in the cookie jar. */
  | { status: "refreshed"; session: Session; expiresIn: number }
  /** Nothing to refresh with: the caller is simply signed out. */
  | { status: "no_refresh_token" }
  /**
   * The proof of activity did not hold — see {@link IdleProof}. Unless the
   * caller asked otherwise (`endIdleSession: false`), the refresh token has
   * been revoked at Cognito and every cookie cleared.
   */
  | { status: "idle"; proof: IdleProof }
  /** The refresh token is dead for good. Session cookies have been cleared. */
  | { status: "invalid" }
  /** Cognito could not answer. Cookies are untouched so a retry can succeed. */
  | { status: "unavailable" };

export interface RefreshSessionOptions {
  /**
   * Whether an idle verdict may *act*: revoke the refresh token at Cognito and
   * clear every cookie. Default `true`.
   *
   * `GET /api/auth/refresh` passes `false` for a `cross-site` request. That GET
   * is a top-level navigation any page on the web can cause, and the cookies
   * ride along because they are `sameSite: "lax"` — so acting on it would hand
   * an attacker a one-link forced sign-out. The verdict is still reported and
   * the route still redirects; the next same-site request reaches the same
   * conclusion and does the revoking.
   */
  endIdleSession?: boolean;
}

/**
 * Reports — and, unless the caller opted out, acts on — an idle verdict:
 * revokes the refresh token so the copy in the jar is worthless even if it is
 * stolen on its way out, then clears every cookie. Revocation is best effort,
 * exactly as at logout — `revokeRefreshToken` swallows its own failures.
 */
async function idleOutcome(
  refreshToken: string,
  proof: IdleProof,
  endSession: boolean,
): Promise<RefreshOutcome> {
  if (!endSession) {
    // A cross-site navigation. Say what happened, touch nothing: see
    // {@link RefreshSessionOptions.endIdleSession}.
    return { status: "idle", proof };
  }
  console.warn(
    proof === "missing"
      ? "[auth] Refresh refused: the session carries no proof of activity."
      : `[auth] Refresh refused: the session has been idle for more than ${IDLE_TIMEOUT_SECONDS} seconds.`,
  );
  await revokeRefreshToken(refreshToken);
  await clearSession();
  return { status: "idle", proof };
}

/**
 * Exchanges the refresh-token cookie for a new session.
 *
 * The refresh cookies are scoped to `/api/auth`, so this only sees them when
 * called from a route under that path.
 *
 * A `"unavailable"` outcome deliberately leaves every cookie in place: a
 * throttled or unreachable Cognito must never cost an operator their session.
 * Only a verdict — from Cognito that the token is dead, or from the proof
 * cookie that the browser has been idle — clears it.
 */
export async function refreshSession(
  options: RefreshSessionOptions = {},
): Promise<RefreshOutcome> {
  const endSession = options.endIdleSession ?? true;
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return { status: "no_refresh_token" };
  }

  // The last id token this browser was given. Written beside the refresh token
  // and with the same lifetime, so a refresh token without one means either a
  // session created before this cookie existed — those get one forced sign-in,
  // which is the intended cost of the change — or a jar someone has edited.
  const proof = cookieStore.get(REFRESH_PROOF_COOKIE)?.value;
  if (!proof) {
    return idleOutcome(refreshToken, "missing", endSession);
  }

  // The sign-in method cookie was signed against the proof token (the id token
  // issued last), so this is where it is read; `createSession` below re-signs
  // it against the new one. A session without the cookie reads as `password`
  // and stays that way until the next sign-in.
  let proofSession: Session | null;
  try {
    proofSession = await verifyRecentIdToken(
      proof,
      IDLE_TIMEOUT_SECONDS,
      cookieStore.get(SIGN_IN_METHOD_COOKIE)?.value,
    );
  } catch {
    // The JWKS endpoint is unreachable — an outage, not an idle browser. Leave
    // every cookie alone; the next attempt can still succeed.
    return { status: "unavailable" };
  }
  if (!proofSession) {
    // Expired more than the idle window ago, forged, or from another pool.
    return idleOutcome(refreshToken, "stale", endSession);
  }

  let result;
  try {
    result = await refreshTokens(refreshToken);
  } catch (error) {
    if (error instanceof CognitoConfigError) {
      console.error("[auth] Cannot refresh, Cognito is not configured:", error);
      return { status: "unavailable" };
    }
    throw error;
  }

  if (!result.ok) {
    if (result.reason === "unavailable") {
      return { status: "unavailable" };
    }
    await clearSession();
    return { status: "invalid" };
  }

  // Defensive: Cognito just minted this token, so it should verify. If it does
  // not, something is wrong enough that continuing with it would be worse than
  // signing the user out.
  let session: Session | null;
  try {
    session = await verifyIdToken(result.idToken);
  } catch {
    // The JWKS endpoint is unreachable — an outage, not a bad token.
    return { status: "unavailable" };
  }
  if (!session) {
    console.error("[auth] A freshly refreshed id token did not verify.");
    await clearSession();
    return { status: "invalid" };
  }
  if (session.userId !== proofSession.userId) {
    // Also defensive: the refresh token and the proof of activity must describe
    // the same person. They cannot diverge by accident, so a mismatch means a
    // jar assembled from two sessions.
    console.error(
      "[auth] The refreshed session is for a different user than the proof cookie.",
    );
    await clearSession();
    return { status: "invalid" };
  }

  // The token already on file is passed back so the sliding cookies can be
  // re-dated even when rotation is off and Cognito returned no new one; the
  // sign-in method is carried over so a refresh never weakens the session.
  await createSession(result, refreshToken, proofSession.signInMethod);
  return {
    status: "refreshed",
    session: { ...session, signInMethod: proofSession.signInMethod },
    expiresIn: result.expiresIn,
  };
}
