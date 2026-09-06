/**
 * Cognito configuration, read lazily from the environment.
 *
 * Never import this from a Client Component: the values below (in particular
 * ADMIN_COGNITO_CLIENT_SECRET) must stay on the server. This is the ADMIN
 * user pool; the consumer app's pool must never be accepted here.
 */

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Only set when the Cognito app client is configured with a secret. */
  clientSecret?: string;
}

/**
 * Thrown when a required Cognito environment variable is missing. Callers are
 * expected to catch this, log it, and show a generic "not configured" message.
 */
export class CognitoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CognitoConfigError";
  }
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

/**
 * Returns the first of `names` that is set, so a variable can have documented
 * fallbacks. The error names them all, first (canonical) one first.
 */
function requiredOneOf(...names: [string, ...string[]]): string {
  for (const name of names) {
    const value = optional(name);
    if (value !== undefined) {
      return value;
    }
  }
  const alternatives = names.slice(1);
  throw new CognitoConfigError(
    `Missing required environment variable ${names[0]}${
      alternatives.length > 0 ? ` (or ${alternatives.join(", ")})` : ""
    }.`,
  );
}

/**
 * Reads and validates the Cognito environment variables.
 *
 * Resolved on every call (not memoised at module load) so that a missing
 * variable surfaces as a catchable error at request time rather than crashing
 * the module graph at import time.
 *
 * @throws {CognitoConfigError} when a required variable is missing.
 */
export function getCognitoConfig(): CognitoConfig {
  return {
    // The ADMIN_COGNITO_* names come first so the admin-only user pool can
    // never be confused with the consumer app's pool when both sets of
    // variables are present. The unprefixed names and AWS_REGION are the
    // conventional fallbacks; the NEXT_PUBLIC_ variants are accepted because
    // region, pool id and client id are public identifiers. The client secret
    // has no public fallback.
    region: requiredOneOf(
      "ADMIN_COGNITO_REGION",
      "COGNITO_REGION",
      "AWS_REGION",
      "NEXT_PUBLIC_COGNITO_REGION",
    ),
    userPoolId: requiredOneOf(
      "ADMIN_COGNITO_USER_POOL_ID",
      "COGNITO_USER_POOL_ID",
      "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
    ),
    clientId: requiredOneOf(
      "ADMIN_COGNITO_CLIENT_ID",
      "COGNITO_CLIENT_ID",
      "NEXT_PUBLIC_COGNITO_CLIENT_ID",
    ),
    clientSecret: optional("ADMIN_COGNITO_CLIENT_SECRET") ?? optional("COGNITO_CLIENT_SECRET"),
  };
}
