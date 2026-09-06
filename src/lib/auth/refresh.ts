import "server-only";
/**
 * Turning a refresh token into a fresh session.
 *
 * Nothing in this app calls AWS with the user's tokens, so the only thing that
 * ever needs a refresh is our own session: the id token lives an hour, the
 * refresh token thirty days. `refreshSession()` spends the second to renew the
 * first.
 *
 * **Must be called from a Route Handler or a Server Action.** It writes cookies,
 * which is impossible during render — that is also why `verifySession()` cannot
 * refresh on its own, and why an expired page session is renewed by bouncing the
 * browser through `GET /api/auth/refresh` (see `src/proxy.ts`).
 */
import { cookies } from "next/headers";
import {
  ID_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  REFRESH_USER_COOKIE,
} from "./cookies";
import { refreshTokens } from "./cognito";
import { CognitoConfigError } from "./config";
import {
  clearSession,
  createSession,
  refreshUsernameFrom,
  verifyIdToken,
  type Session,
} from "./session";

export type RefreshOutcome =
  /** New tokens are in the cookie jar. */
  | { status: "refreshed"; session: Session; expiresIn: number }
  /** Nothing to refresh with: the caller is simply signed out. */
  | { status: "no_refresh_token" }
  /** The refresh token is dead for good. Session cookies have been cleared. */
  | { status: "invalid" }
  /** Cognito could not answer. Cookies are untouched so a retry can succeed. */
  | { status: "unavailable" };

/**
 * Exchanges the refresh-token cookie for a new session.
 *
 * The refresh cookies are scoped to `/api/auth`, so this only sees them when
 * called from a route under that path.
 *
 * A `"unavailable"` outcome deliberately leaves every cookie in place: a
 * throttled or unreachable Cognito must never cost a user their 30-day session.
 * Only a verdict from Cognito that the token is dead clears it.
 */
export async function refreshSession(): Promise<RefreshOutcome> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_TOKEN_COOKIE)?.value;
  if (!refreshToken) {
    return { status: "no_refresh_token" };
  }

  // Normally the cookie written beside the refresh token. The id token is a
  // fallback for sessions created before that cookie existed; it is only read
  // for its username, never trusted as a credential. An empty string is fine
  // when the app client has no secret, where the username is unused.
  //
  // `||`, not `??`: a cookie that is present but empty carries no username, and
  // treating "" as a value would compute the SECRET_HASH over nothing and get
  // the refresh rejected instead of falling back to the id token.
  const idToken = cookieStore.get(ID_TOKEN_COOKIE)?.value;
  const username =
    cookieStore.get(REFRESH_USER_COOKIE)?.value ||
    (idToken ? refreshUsernameFrom(idToken) : null) ||
    "";

  let result;
  try {
    result = await refreshTokens(refreshToken, username);
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

  await createSession(result);
  return { status: "refreshed", session, expiresIn: result.expiresIn };
}
