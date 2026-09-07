/**
 * Configuration for the **customer** Cognito user pool — the consumer app's
 * pool, the one real people sign in to. It is a different pool from the one
 * this console authenticates operators against (`src/lib/auth/config.ts`,
 * `ADMIN_COGNITO_*`), and the two must never be confused: an admin token is
 * never accepted here, and nothing read here ever grants admin access.
 *
 * Never import this from a Client Component. Nothing below is a secret (a
 * region and a pool id are public identifiers) but the module exists to serve
 * server-side AWS calls, and the environment it reads is server-side.
 *
 * The AWS credentials the Admin* APIs need are **not** read here. Every
 * `Admin…` call is SigV4-signed and the SDK resolves credentials from its
 * default provider chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, a
 * shared profile, or an instance/task role). Handling them ourselves would
 * only be a way to leak them.
 */

export interface CustomerCognitoConfig {
  region: string;
  /** The consumer app's user pool id, e.g. `ca-central-1_XXXXXXXXX`. */
  userPoolId: string;
}

/**
 * Thrown when a required variable is missing. Callers catch it and report
 * "the customer pool is not configured" rather than failing the whole page:
 * the Customers list works from the database alone.
 */
export class CustomerCognitoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerCognitoConfigError";
  }
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

/** The first of `names` that is set, so a variable can have documented fallbacks. */
function firstOf(...names: [string, ...string[]]): string | undefined {
  for (const name of names) {
    const value = optional(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Reads the customer pool's region and id.
 *
 * Resolved on every call (not memoised at import time) so a missing variable
 * surfaces as a catchable error at request time, the same decision
 * `getCognitoConfig()` makes for the admin pool.
 *
 * `CUSTOMER_COGNITO_USER_POOL_ID` has **no fallback**: falling back to
 * `COGNITO_USER_POOL_ID` would silently point invitations and account lookups
 * at the admin pool. The region does fall back, because a wrong region only
 * fails the call.
 *
 * @throws {CustomerCognitoConfigError} when a required variable is missing.
 */
export function getCustomerCognitoConfig(): CustomerCognitoConfig {
  const userPoolId = optional("CUSTOMER_COGNITO_USER_POOL_ID");
  if (userPoolId === undefined) {
    throw new CustomerCognitoConfigError(
      "Missing required environment variable CUSTOMER_COGNITO_USER_POOL_ID.",
    );
  }
  const region = firstOf(
    "CUSTOMER_COGNITO_REGION",
    "ADMIN_COGNITO_REGION",
    "AWS_REGION",
    "NEXT_PUBLIC_COGNITO_REGION",
  );
  if (region === undefined) {
    throw new CustomerCognitoConfigError(
      "Missing required environment variable CUSTOMER_COGNITO_REGION (or ADMIN_COGNITO_REGION, AWS_REGION, NEXT_PUBLIC_COGNITO_REGION).",
    );
  }
  return { region, userPoolId };
}

/** The config, or `null` with the reason when it is incomplete. */
export function tryCustomerCognitoConfig():
  | { config: CustomerCognitoConfig; reason: null }
  | { config: null; reason: string } {
  try {
    return { config: getCustomerCognitoConfig(), reason: null };
  } catch (error) {
    return {
      config: null,
      reason:
        error instanceof CustomerCognitoConfigError
          ? error.message
          : "The customer Cognito pool is not configured.",
    };
  }
}
