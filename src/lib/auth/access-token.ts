import "server-only";
/**
 * Reading the operator's Cognito **access token** out of the request.
 *
 * Almost everything in this app is authorised with the *id* token: it carries
 * the identity, and `authenticate()` verifies it. Cognito's self-service
 * operations are the exception — `ChangePassword`, `AssociateSoftwareToken`,
 * `SetUserMFAPreference`, the WebAuthn calls — because they act *as the user*
 * and AWS insists on an access token with the
 * `aws.cognito.signin.user.admin` scope.
 *
 * That token is already in the cookie jar (`psa_access_token`, path `/`), set
 * beside the id token by `createSession()` and refreshed with it, so nothing
 * new has to be stored. It is read here and nowhere else, and it never leaves
 * the server: it is handed straight to the AWS SDK.
 */
import type { NextRequest } from "next/server";
import { ApiError, UnauthorizedError } from "@/lib/api/errors";
import { ACCESS_TOKEN_COOKIE, SESSION_MARKER_COOKIE } from "./cookies";

/** The access token cookie, or `null` when this caller has none. */
export function accessTokenFrom(request: NextRequest): string | null {
  return request.cookies.get(ACCESS_TOKEN_COOKIE)?.value ?? null;
}

/**
 * The access token, or a refusal the client can act on.
 *
 * The id and access cookies are written and expire together, so a request that
 * authenticated with the id token normally has both. When it does not:
 *
 * - a browser that still holds a refresh token (the `psa_session` marker) gets
 *   401 `token_expired`, which is the code `apiFetch` answers by refreshing
 *   once and retrying once — exactly the right cure for a half-expired jar;
 * - anyone else (a `Authorization: Bearer` script, which has no cookies at
 *   all) gets a plain 401 saying why. A bearer id token cannot stand in: only
 *   Cognito can mint an access token for these calls.
 *
 * @throws {ApiError} 401 `token_expired` or {@link UnauthorizedError}.
 */
export function requireAccessToken(request: NextRequest): string {
  const token = accessTokenFrom(request);
  if (token) {
    return token;
  }
  if (request.cookies.has(SESSION_MARKER_COOKIE)) {
    throw new ApiError(
      401,
      "token_expired",
      "Session expired; refresh and retry.",
    );
  }
  throw new UnauthorizedError(
    "This operation needs a signed-in browser session; a bearer id token cannot be used for it.",
  );
}
