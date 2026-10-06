import "server-only";
/**
 * Recovery codes as the Account & security routes use them
 * (`docs/two-factor-plan.md`, phase B). `./service.ts` is Cognito only and
 * writes nothing to a database; this module is where the pool's answer and
 * the console's own `admin_user_recovery_codes` rows (`./recovery-codes.ts`)
 * meet:
 *
 * - the status read gains the codes summary — best effort: a failed read is
 *   logged and answered as "no codes", never a 500 that empties the whole
 *   drawer (the stage test of 2026-10-04: a table the app's role could not
 *   use, 42501, took the drawer down with it);
 * - enrolment issues the ten codes once the factor is on — and **never fails
 *   because of them**: a failed insert is logged, `issuedRecoveryCodes` is
 *   null, and the drawer offers "Generate them now";
 * - turning the factor off deletes the rows, best effort, once Cognito has
 *   accepted — a 500 there would tell the drawer the factor is still on;
 * - after either switch the summary read is best effort too: with the admin
 *   database down the factor has still flipped at Cognito, so the route
 *   answers "no codes" rather than 500;
 * - "Generate new codes" replaces the set behind a password re-check; before
 *   SQL 022, or while the table belongs to another role (42501), it is a 503
 *   `admin_schema_missing`, like every other feature.
 *
 * Redeeming a code happens at `/login` (`src/app/login/actions.ts`), not here.
 */
import { ApiError, ServiceUnavailableError, ValidationError } from "@/lib/api/errors";
import { verifyPasswordForSensitiveAction } from "@/lib/auth/cognito";
import { CognitoConfigError } from "@/lib/auth/config";
import {
  deleteRecoveryCodes,
  isSchemaFaultError,
  RECOVERY_CODES_TABLE_SQL,
  replaceRecoveryCodes,
  summariseRecoveryCodes,
  type RecoveryCodesSummary,
} from "./recovery-codes";
import { getMfaStatus } from "./service";
import type { MfaStatus, MfaStatusView, TotpEnrolmentResult } from "./types";

/**
 * What this module reaches for — the pool (through `./service` and the
 * password re-check) and the codes table — so the best-effort rules can be
 * tested against stubs (`./recovery.test.ts`). Production callers pass
 * nothing and get the real functions.
 */
export interface RecoveryGateway {
  verifyPassword: typeof verifyPasswordForSensitiveAction;
  getMfaStatus: typeof getMfaStatus;
  replaceRecoveryCodes: typeof replaceRecoveryCodes;
  summariseRecoveryCodes: typeof summariseRecoveryCodes;
  deleteRecoveryCodes: typeof deleteRecoveryCodes;
}

const defaultGateway: RecoveryGateway = {
  verifyPassword: verifyPasswordForSensitiveAction,
  getMfaStatus,
  replaceRecoveryCodes,
  summariseRecoveryCodes,
  deleteRecoveryCodes,
};

/** The API code a wrong password comes back with (401). */
export const PASSWORD_INCORRECT_CODE = "password_incorrect";

/** The API code a Cognito outage during the re-check comes back with (503). */
const AUTH_UNAVAILABLE_CODE = "auth_unavailable";

/**
 * Whether the password was proven before {@link regenerateRecoveryCodes}
 * threw: true for everything but the two answers the re-check itself gives —
 * 401 `password_incorrect` and 503 `auth_unavailable`. The route uses it to
 * give the `authLoginAccount` slot back on a failure that came *after* the
 * password (the authenticator off, the table missing, a database fault),
 * because the sign-in budgets count failed attempts only (owner,
 * 2026-10-06). The 401 covers the temporary-password case too, which a
 * signed-in operator cannot be in, so it is not told apart.
 */
export function passwordProvenDespite(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.code !== PASSWORD_INCORRECT_CODE && error.code !== AUTH_UNAVAILABLE_CODE;
}

/** What `POST /api/v1/admin/me/mfa/recovery-codes` refuses with before the set is touched. */
const TURN_ON_FIRST_MESSAGE = "Turn on the authenticator app first.";

/** The pool's answer plus the codes summary, pinned to the operator's own row. */
export async function withRecoveryCodes(status: MfaStatus, userId: string): Promise<MfaStatusView> {
  return { ...status, recoveryCodes: await summariseRecoveryCodes(userId) };
}

/** The summary's empty value: what a route answers when the read itself fails. */
const NO_RECOVERY_CODES: RecoveryCodesSummary = { remaining: 0, total: 0, usedAt: null };

/**
 * The summary, best effort: a failed read (the admin database down, a table
 * the app's role may not use) is logged and answered as "no codes". Once
 * Cognito has accepted a switch, a 500 here would tell the drawer the factor
 * did not flip when it did; on the plain status read it would take the whole
 * drawer down over one row of it.
 */
async function summariseOrEmpty(userId: string, gateway: RecoveryGateway): Promise<RecoveryCodesSummary> {
  try {
    return await gateway.summariseRecoveryCodes(userId);
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`[account] recovery codes: summary unavailable (${name})`);
    return { ...NO_RECOVERY_CODES };
  }
}

/**
 * The status read with the codes summary: one Cognito call, one database
 * read. The Cognito answer decides the drawer; the summary is best effort
 * and never fails it.
 */
export async function getMfaStatusView(
  accessToken: string,
  userId: string,
  gateway: RecoveryGateway = defaultGateway,
): Promise<MfaStatusView> {
  const status = await gateway.getMfaStatus(accessToken);
  return { ...status, recoveryCodes: await summariseOrEmpty(userId, gateway) };
}

/**
 * Right after the authenticator app went on: the ten codes, issued once.
 * Enrolment never fails because of codes — a failed write is logged and
 * answered as `issuedRecoveryCodes: null`.
 */
export async function issueRecoveryCodesAfterEnrolment(
  status: MfaStatus,
  userId: string,
  gateway: RecoveryGateway = defaultGateway,
): Promise<TotpEnrolmentResult> {
  let issuedRecoveryCodes: string[] | null = null;
  try {
    issuedRecoveryCodes = await gateway.replaceRecoveryCodes(userId);
  } catch (error) {
    console.error(
      `[account] user ${userId}: the authenticator app is on but the recovery codes could not be created.`,
      error,
    );
  }
  return {
    ...status,
    recoveryCodes: await summariseOrEmpty(userId, gateway),
    issuedRecoveryCodes,
  };
}

/**
 * After Cognito accepted the switch-off: the rows go. Best effort and logged;
 * leftover rows only ever show the drawer banner until the next enrolment
 * replaces them.
 */
export async function clearRecoveryCodesAfterDisable(
  status: MfaStatus,
  userId: string,
  gateway: RecoveryGateway = defaultGateway,
): Promise<MfaStatusView> {
  try {
    await gateway.deleteRecoveryCodes(userId);
  } catch (error) {
    console.error(
      `[account] user ${userId}: the authenticator app is off but the recovery codes could not be deleted.`,
      error,
    );
  }
  return { ...status, recoveryCodes: await summariseOrEmpty(userId, gateway) };
}

/**
 * "Generate new codes": replaces the operator's set behind a password
 * re-check. The route has charged the `authLoginAccount` and `accountMfa`
 * budgets already — this proves a password, so it must not be a cheaper
 * place to guess than `/login`.
 *
 * The re-check: a second-factor challenge from Cognito is proof the password
 * was right (the challenge is left unanswered), `NEW_PASSWORD_REQUIRED` is
 * refused, and an outage is a 503, never "wrong password". Codes are refused
 * while the authenticator is off: there is nothing to recover from, so they
 * would only be noise.
 *
 * @throws {ApiError} 401 `password_incorrect`, 422 when the authenticator is
 * off, 503 `auth_unavailable`, 503 `admin_schema_missing` until
 * `docs/sql/022_admin_user_recovery_codes.sql` has been run — as the role
 * that owns `admin_users`, else the table answers 42501 and the 503 stands.
 */
export async function regenerateRecoveryCodes(
  accessToken: string,
  operator: { id: string; email: string },
  password: string,
  gateway: RecoveryGateway = defaultGateway,
): Promise<string[]> {
  let check;
  try {
    check = await gateway.verifyPassword(operator.email, password);
  } catch (error) {
    if (error instanceof CognitoConfigError) {
      console.error("[account] generate recovery codes: Cognito is not configured:", error);
      throw new ServiceUnavailableError(
        AUTH_UNAVAILABLE_CODE,
        "Your password could not be checked right now. Please try again.",
      );
    }
    throw error;
  }
  if (!check.ok) {
    if (check.failure === "unavailable") {
      throw new ServiceUnavailableError(
        AUTH_UNAVAILABLE_CODE,
        "Your password could not be checked right now. Please try again.",
      );
    }
    if (check.failure === "challenge") {
      throw new ApiError(
        401,
        PASSWORD_INCORRECT_CODE,
        "This account has to finish setting its password first. Sign out, sign in again to set a new password, then try again.",
      );
    }
    throw new ApiError(401, PASSWORD_INCORRECT_CODE, "The password is incorrect.");
  }

  const status = await gateway.getMfaStatus(accessToken);
  if (!status.totpEnabled) {
    throw new ValidationError(TURN_ON_FIRST_MESSAGE);
  }

  try {
    return await gateway.replaceRecoveryCodes(operator.id);
  } catch (error) {
    if (!isSchemaFaultError(error)) throw error;
    console.warn(
      `[account] generate recovery codes: admin_user_recovery_codes does not exist yet or the app's role may not use it (run ${RECOVERY_CODES_TABLE_SQL}; if the table exists, its owner must match admin_users — see the DO block at the end of the file).`,
    );
    throw new ServiceUnavailableError(
      "admin_schema_missing",
      `The admin database is not ready for recovery codes. Run ${RECOVERY_CODES_TABLE_SQL} (the table must be owned by the same role as admin_users).`,
    );
  }
}
