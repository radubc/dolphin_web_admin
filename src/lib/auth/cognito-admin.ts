import "server-only";
/**
 * The two **admin** Cognito calls a recovery-code sign-in needs on the
 * operators' own pool (`docs/two-factor-plan.md`, phase B; the design is the
 * consumer app's `docs/recovery-codes.md`, section 3): find who the address
 * the password was just proven for belongs to, and turn their second factor
 * off.
 *
 * These are `Admin…` APIs, signed with the SDK's default credential chain —
 * the ECS task role in AWS (`infra/service-admin.yaml`, policy
 * `operator-recovery`: `AdminGetUser` and `AdminSetUserMFAPreference` on the
 * **admin** pool ARN), a local AWS profile on a laptop — never the person's
 * own access token, because at `/login` there is none yet. This is the only
 * module that addresses the admin pool with AWS credentials; everything in
 * `src/lib/customers/cognito.ts` is the customers' pool and must stay so.
 *
 * Same shape as the consumer app's `src/lib/auth/cognito-admin.ts`: every
 * function takes an optional {@link PoolAccess} so the tests can stub the
 * client (`./cognito-admin.test.ts`); production callers pass nothing.
 *
 * Nothing here throws for a Cognito verdict, and nothing logs an address: the
 * log carries the error *name* and the permission the call needed, so an
 * operator can tell a missing IAM grant from an outage. The one exception is
 * `CognitoConfigError` (a missing `ADMIN_COGNITO_*` variable), which
 * propagates so the caller can say "not configured" rather than "wrong code".
 */
import {
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { cognitoClient } from "./cognito";
import { getCognitoConfig } from "./config";

/* -------------------------------------------------------------------------- */
/* The client                                                                 */
/* -------------------------------------------------------------------------- */

type PoolCommand = AdminGetUserCommand | AdminSetUserMFAPreferenceCommand;

/** The pool and a way to send it one command. */
export interface PoolAccess {
  userPoolId: string;
  send: (command: PoolCommand) => Promise<unknown>;
}

/** The IAM policy in `infra/service-admin.yaml` that grants these two calls. */
const POLICY_NAME = "operator-recovery";

/**
 * The admin pool through the process-wide client (`cognitoClient`).
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
function defaultPool(): PoolAccess {
  const config = getCognitoConfig();
  const client = cognitoClient();
  return {
    userPoolId: config.userPoolId,
    send: (command) => client.send(command as AdminGetUserCommand),
  };
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return String((error as { name?: unknown } | null)?.name ?? "");
}

/**
 * One log line per refusal, naming the permission so a missing grant on the
 * task role (or the local profile) reads as what it is.
 */
function logRefusal(error: unknown, permission: string): void {
  const name = errorName(error) || "Error";
  switch (name) {
    case "AccessDeniedException":
    case "NotAuthorizedException":
    case "UnrecognizedClientException":
    case "ExpiredTokenException":
    case "CredentialsProviderError":
      console.error(
        `[auth] ${permission} was refused by AWS (${name}). The task role (or local profile) needs cognito-idp:${permission} on the admin pool (policy ${POLICY_NAME}).`,
      );
      return;
    case "LimitExceededException":
    case "TooManyRequestsException":
      console.warn(`[auth] ${permission} was throttled by Cognito: ${name}.`);
      return;
    case "ResourceNotFoundException":
      console.error(
        `[auth] ${permission}: the pool in ADMIN_COGNITO_USER_POOL_ID does not exist in this region (${name}).`,
      );
      return;
    default:
      console.error(`[auth] ${permission} failed: ${name}.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Who                                                                        */
/* -------------------------------------------------------------------------- */

/** A sign-in as the recovery step needs it. */
export interface AdminPoolUser {
  /** The pool's own username, which `AdminSetUserMFAPreference` is keyed by. */
  username: string;
  /** The immutable `sub`, which `admin_users.cognito_sub` holds. */
  sub: string;
  /** The pool's `email` attribute, as stored; equal to the address looked up, case aside. */
  email: string;
}

export type AdminFindUserResult =
  /**
   * `user` is null when the pool has no such sign-in — or when the sign-in it
   * answered is not the address asked for (see {@link adminFindUser}).
   */
  | { ok: true; user: AdminPoolUser | null }
  /** AWS refused or could not be reached; logged. Not a verdict on the person. */
  | { ok: false };

/** Two addresses are the same sign-in when they agree ignoring case and edges. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * `AdminGetUser` by the **address the password was proven for** (the pool
 * signs in by email and is case-insensitive). Nothing the browser chose —
 * the hidden `username` of the challenge, say — may pick the account here:
 * the password proves one address, and the account acted on must be that one,
 * or an operator with their own authenticator-enrolled account could post
 * their own address and password with a colleague's code and have the
 * colleague's factor turned off. Belt and braces, the answer's `email`
 * attribute is checked against the address too; a mismatch is answered as
 * "no such sign-in", which the caller turns into the neutral error.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function adminFindUser(
  email: string,
  pool: PoolAccess = defaultPool(),
): Promise<AdminFindUserResult> {
  let response: AdminGetUserCommandOutput;
  try {
    response = (await pool.send(
      new AdminGetUserCommand({ UserPoolId: pool.userPoolId, Username: email }),
    )) as AdminGetUserCommandOutput;
  } catch (error) {
    if (errorName(error) === "UserNotFoundException") return { ok: true, user: null };
    logRefusal(error, "AdminGetUser");
    return { ok: false };
  }
  const sub = response.UserAttributes?.find((entry) => entry.Name === "sub")?.Value ?? null;
  if (sub === null || !response.Username) {
    console.error("[auth] AdminGetUser answered without a username or a sub.");
    return { ok: false };
  }
  const address = response.UserAttributes?.find((entry) => entry.Name === "email")?.Value ?? null;
  if (address === null || !sameAddress(address, email)) {
    console.error(
      "[auth] AdminGetUser answered a sign-in whose email attribute is not the address the password was proven for; refusing.",
    );
    return { ok: true, user: null };
  }
  return { ok: true, user: { username: response.Username, sub, email: address } };
}

/* -------------------------------------------------------------------------- */
/* Off                                                                        */
/* -------------------------------------------------------------------------- */

export type AdminTurnOffSecondFactorResult =
  | { ok: true }
  /** Cognito refused or could not be reached; logged with the permission name. */
  | { ok: false };

/**
 * Turns the authenticator app off for an operator, and passkey MFA with it,
 * in one `AdminSetUserMFAPreference` — the admin twin of the self-service
 * call in `src/lib/account/service.ts` (`disableTotpAndPasskeyMfa`) and the
 * same request `resetTwoFactor` sends on the customers' pool: Cognito wants
 * another factor on while passkey MFA is, so both go together.
 *
 * The TOTP secret stays associated at Cognito; enrolling again walks the whole
 * setup flow anyway, and sets both flags again (`ensurePasskeyMfa`). A passkey
 * keeps working as a first factor.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function adminTurnOffSecondFactor(
  username: string,
  pool: PoolAccess = defaultPool(),
): Promise<AdminTurnOffSecondFactorResult> {
  try {
    await pool.send(
      new AdminSetUserMFAPreferenceCommand({
        UserPoolId: pool.userPoolId,
        Username: username,
        SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
        WebAuthnMfaSettings: { Enabled: false },
      }),
    );
    return { ok: true };
  } catch (error) {
    logRefusal(error, "AdminSetUserMFAPreference");
    return { ok: false };
  }
}
