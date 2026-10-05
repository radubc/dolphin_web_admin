import "server-only";
/**
 * How a session was signed in, and the signed cookie that carries it
 * (`docs/two-factor-plan.md`, phase C). Split out of `./session` so the
 * HMAC helpers can be unit-tested without `next/headers`
 * (`./sign-in-method.test.ts`); `./session` re-exports the public names, so
 * every existing import of `SignInMethod` keeps working.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decomposeUnverifiedJwt } from "aws-jwt-verify/jwt";
import { getCognitoConfig } from "./config";

/**
 * How a session was signed in, recorded at `createSession` by the three
 * sign-in paths in `src/app/login/actions.ts`:
 *
 * - `password` — email and password, no second step (the account has no
 *   authenticator app);
 * - `password+totp` — password, then the six-digit authenticator code;
 * - `passkey` — a WebAuthn assertion, which the admin pool treats as both
 *   factors (`docs/auth.md`, "Passkey MFA").
 *
 * Read by the one operation that insists on a second factor: turning off a
 * customer's two-factor authentication (`docs/access-control.md`). Chosen
 * over the id token's `amr` claim, which the pool is not known to emit.
 */
export const SIGN_IN_METHODS = ["password", "password+totp", "passkey"] as const;

export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export function isSignInMethod(value: string): value is SignInMethod {
  return (SIGN_IN_METHODS as readonly string[]).includes(value);
}

/** The methods that count as a second factor for a step-up check. */
export function isSecondFactorSignIn(method: SignInMethod): boolean {
  return method !== "password";
}

/* -------------------------------------------------------------------------- */
/*                           The sign-in method cookie                        */
/* -------------------------------------------------------------------------- */

/**
 * The HMAC key the sign-in method cookie is signed with.
 *
 * Derived from the admin app client's secret when one is configured — the
 * deployed task definitions set `ADMIN_COGNITO_CLIENT_SECRET`, so every
 * instance derives the same key and a session signed in on one task verifies
 * on another. Without a client secret (a local `.env` without one) the key is
 * random per process and parked on `globalThis`, like the rate limiter, so a
 * dev-server edit does not invalidate it; a restart does, and the session
 * then reads as password-only until the next sign-in. Fails closed either
 * way: an unverifiable cookie is never believed.
 *
 * In production the per-process key is a misconfiguration — with several
 * tasks behind the load balancer a cookie signed by one is rejected by the
 * next — so it is warned about once per process.
 */
const globalForSignInMethod = globalThis as unknown as {
  pennySqueezeAdminSignInMethodKey?: Buffer;
  pennySqueezeAdminSignInMethodKeyWarned?: boolean;
};

function signInMethodKey(): Buffer {
  let clientSecret: string | undefined;
  try {
    clientSecret = getCognitoConfig().clientSecret;
  } catch {
    clientSecret = undefined;
  }
  if (clientSecret) {
    return createHmac("sha256", clientSecret).update("psa_sign_in_method").digest();
  }
  if (
    process.env.NODE_ENV === "production" &&
    !globalForSignInMethod.pennySqueezeAdminSignInMethodKeyWarned
  ) {
    globalForSignInMethod.pennySqueezeAdminSignInMethodKeyWarned = true;
    console.warn(
      "[auth] ADMIN_COGNITO_CLIENT_SECRET is not set: the sign-in-method cookie cannot be shared between tasks, so the customer two-factor reset will read every session as password-only.",
    );
  }
  globalForSignInMethod.pennySqueezeAdminSignInMethodKey ??= randomBytes(32);
  return globalForSignInMethod.pennySqueezeAdminSignInMethodKey;
}

/** What the signature covers: the subject, the sign-in, and the claim itself. */
function signInMethodSignature(method: SignInMethod, sub: string, originJti: string): string {
  return createHmac("sha256", signInMethodKey())
    .update(`${sub}\n${originJti}\n${method}`)
    .digest("base64url");
}

/**
 * `sub` and `origin_jti` of a token, decoded without verification.
 *
 * Only used to *sign* the method cookie against a token that arrived over TLS
 * from the sign-in or refresh call we just made (see `tokenExpiry` in
 * `./session` for the same reasoning); every *read* of the cookie checks it
 * against the verified payload instead. `origin_jti` identifies the original
 * sign-in and is carried across refreshes; the refresh path re-signs the
 * cookie against each new token.
 *
 * Cognito only puts `origin_jti` in a token when the app client has token
 * revocation on. Without it there is nothing to tie the cookie to one
 * sign-in — the same cookie would verify for every session of that subject —
 * so the method is not trusted: `null` here, which means no cookie is
 * written and the session reads as `password`.
 */
function tokenBinding(token: string): { sub: string; originJti: string } | null {
  try {
    const { payload } = decomposeUnverifiedJwt(token);
    if (typeof payload.sub !== "string" || payload.sub === "") return null;
    if (typeof payload.origin_jti !== "string" || payload.origin_jti === "") return null;
    return { sub: payload.sub, originJti: payload.origin_jti };
  } catch (error) {
    console.error("[auth] Could not read a token's subject:", error);
    return null;
  }
}

/**
 * The cookie value: `<method>.<signature>`, or `null` for a token the cookie
 * cannot be bound to (no subject, no `origin_jti`), in which case the caller
 * sets no cookie at all.
 */
export function signInMethodCookieValue(method: SignInMethod, token: string): string | null {
  const binding = tokenBinding(token);
  if (binding === null) return null;
  return `${method}.${signInMethodSignature(method, binding.sub, binding.originJti)}`;
}

/**
 * The sign-in method a cookie claims, if its signature holds for this
 * verified payload; otherwise `password`, the weakest answer.
 *
 * A mismatch is not necessarily tampering — a session signed on a process
 * whose random key is gone (no client secret configured) looks the same — so
 * it is logged at `info`, without the cookie's content.
 *
 * A payload without `origin_jti` (token revocation off on the app client)
 * reads as `password` whatever the cookie says: the signature cannot have
 * been bound to this sign-in, and {@link tokenBinding} would never have
 * written one — see there.
 */
export function signInMethodFrom(
  cookieValue: string | undefined,
  payload: { sub: string; origin_jti?: unknown },
): SignInMethod {
  if (cookieValue === undefined || cookieValue === "") return "password";
  if (typeof payload.origin_jti !== "string" || payload.origin_jti === "") return "password";
  const dot = cookieValue.lastIndexOf(".");
  const method = dot === -1 ? "" : cookieValue.slice(0, dot);
  const signature = dot === -1 ? "" : cookieValue.slice(dot + 1);
  if (!isSignInMethod(method)) return "password";
  const expected = signInMethodSignature(method, payload.sub, payload.origin_jti);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    console.info(
      "[auth] The sign-in method cookie did not verify for this session; treating it as a password sign-in.",
    );
    return "password";
  }
  return method;
}
