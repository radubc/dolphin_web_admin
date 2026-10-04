import "server-only";
/**
 * Recovery codes as the Account & security routes use them
 * (`docs/two-factor-plan.md`, phase B). `./service.ts` is Cognito only and
 * writes nothing to a database; this module is where the pool's answer and
 * the console's own `admin_user_recovery_codes` rows (`./recovery-codes.ts`)
 * meet:
 *
 * - the status read gains the codes summary;
 * - enrolment issues the ten codes once the factor is on — and **never fails
 *   because of them**: a failed insert is logged, `issuedRecoveryCodes` is
 *   null, and the drawer offers "Generate them now";
 * - turning the factor off deletes the rows, best effort, once Cognito has
 *   accepted — a 500 there would tell the drawer the factor is still on;
 * - after either switch the summary read is best effort too: with the admin
 *   database down the factor has still flipped at Cognito, so the route
 *   answers "no codes" rather than 500;
 * - "Generate new codes" replaces the set behind a password re-check; before
 *   SQL 022 it is a 503 `admin_schema_missing`, like every other feature.
 *
 * Redeeming a code happens at `/login` (`src/app/login/actions.ts`), not here.
 */
import { ApiError, ServiceUnavailableError, ValidationError } from "@/lib/api/errors";
import { verifyPasswordForSensitiveAction } from "@/lib/auth/cognito";
import { CognitoConfigError } from "@/lib/auth/config";
import {
  deleteRecoveryCodes,
  isMissingTableError,
  RECOVERY_CODES_TABLE_SQL,
  replaceRecoveryCodes,
  summariseRecoveryCodes,
  type RecoveryCodesSummary,
} from "./recovery-codes";
import { getMfaStatus } from "./service";
import type { MfaStatus, MfaStatusView, TotpEnrolmentResult } from "./types";

/** The API code a wrong password comes back with (401). */
export const PASSWORD_INCORRECT_CODE = "password_incorrect";

/** What `POST /api/v1/admin/me/mfa/recovery-codes` refuses with before the set is touched. */
const TURN_ON_FIRST_MESSAGE = "Turn on the authenticator app first.";

/** The pool's answer plus the codes summary, pinned to the operator's own row. */
export async function withRecoveryCodes(status: MfaStatus, userId: string): Promise<MfaStatusView> {
  return { ...status, recoveryCodes: await summariseRecoveryCodes(userId) };
}

/** The summary's empty value: what a route answers when the read itself fails. */
const NO_RECOVERY_CODES: RecoveryCodesSummary = { remaining: 0, total: 0, usedAt: null };

/**
 * The summary once Cognito has already accepted a switch: a failed read (the
 * admin database down, say) is logged and answered as "no codes", because a
 * 500 here would tell the drawer the factor did not flip when it did.
 */
async function summariseAfterCognitoAccepted(userId: string): Promise<RecoveryCodesSummary> {
  try {
    return await summariseRecoveryCodes(userId);
  } catch (error) {
    const name = error instanceof Error ? error.name : typeof error;
    console.error(`[account] recovery codes: summary unavailable (${name})`);
    return { ...NO_RECOVERY_CODES };
  }
}

/**
 * The status read with the codes summary: one Cognito call, one database read.
 */
export async function getMfaStatusView(accessToken: string, userId: string): Promise<MfaStatusView> {
  return withRecoveryCodes(await getMfaStatus(accessToken), userId);
}

/**
 * Right after the authenticator app went on: the ten codes, issued once.
 * Enrolment never fails because of codes — a failed write is logged and
 * answered as `issuedRecoveryCodes: null`.
 */
export async function issueRecoveryCodesAfterEnrolment(
  status: MfaStatus,
  userId: string,
): Promise<TotpEnrolmentResult> {
  let issuedRecoveryCodes: string[] | null = null;
  try {
    issuedRecoveryCodes = await replaceRecoveryCodes(userId);
  } catch (error) {
    console.error(
      `[account] user ${userId}: the authenticator app is on but the recovery codes could not be created.`,
      error,
    );
  }
  return {
    ...status,
    recoveryCodes: await summariseAfterCognitoAccepted(userId),
    issuedRecoveryCodes,
  };
}

/**
 * After Cognito accepted the switch-off: the rows go. Best effort and logged;
 * leftover rows only ever show the drawer banner until the next enrolment
 * replaces them.
 */
export async function clearRecoveryCodesAfterDisable(status: MfaStatus, userId: string): Promise<MfaStatusView> {
  try {
    await deleteRecoveryCodes(userId);
  } catch (error) {
    console.error(
      `[account] user ${userId}: the authenticator app is off but the recovery codes could not be deleted.`,
      error,
    );
  }
  return { ...status, recoveryCodes: await summariseAfterCognitoAccepted(userId) };
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
 * `docs/sql/022_admin_user_recovery_codes.sql` has been run.
 */
export async function regenerateRecoveryCodes(
  accessToken: string,
  operator: { id: string; email: string },
  password: string,
): Promise<string[]> {
  let check;
  try {
    check = await verifyPasswordForSensitiveAction(operator.email, password);
  } catch (error) {
    if (error instanceof CognitoConfigError) {
      console.error("[account] generate recovery codes: Cognito is not configured:", error);
      throw new ServiceUnavailableError(
        "auth_unavailable",
        "Your password could not be checked right now. Please try again.",
      );
    }
    throw error;
  }
  if (!check.ok) {
    if (check.failure === "unavailable") {
      throw new ServiceUnavailableError(
        "auth_unavailable",
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

  const status = await getMfaStatus(accessToken);
  if (!status.totpEnabled) {
    throw new ValidationError(TURN_ON_FIRST_MESSAGE);
  }

  try {
    return await replaceRecoveryCodes(operator.id);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    console.warn(
      `[account] generate recovery codes: admin_user_recovery_codes does not exist yet (run ${RECOVERY_CODES_TABLE_SQL}).`,
    );
    throw new ServiceUnavailableError(
      "admin_schema_missing",
      `The admin database schema is not installed. Run the SQL in ${RECOVERY_CODES_TABLE_SQL}.`,
    );
  }
}
