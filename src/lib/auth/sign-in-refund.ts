/**
 * When a sign-in attempt gets its rate-limit slot back.
 *
 * The sign-in budgets count failed attempts only (owner, 2026-10-06, both
 * apps): a charge is made before Cognito is asked, as always, and given back
 * through `refundRateLimit()` once Cognito has *accepted* what the attempt
 * carried. These are the two verdicts that need reading, kept pure so
 * `./sign-in-refund.test.ts` can pin them down without Next or Cognito:
 *
 * - **Never on an outage or a throttle**: nothing was judged, so nothing is
 *   given back; the slot stays spent, exactly as a wrong guess does.
 * - **Never on a wrong password or code.**
 * - **A challenge is acceptance.** Cognito only issues `SOFTWARE_TOKEN_MFA`
 *   (or any other second factor) after the password was right, and
 *   `NEW_PASSWORD_REQUIRED` after the temporary password was: neither is a
 *   failed attempt, so both refund.
 */
import type { PasswordCheckResult, SignInResult } from "./cognito";

/**
 * Whether `signInWithPassword()` had its password accepted: tokens, the
 * invitation challenge or the authenticator challenge. A refusal — wrong
 * password, unknown account, an unsupported challenge, an outage — keeps the
 * slot spent.
 */
export function passwordAccepted(result: SignInResult): boolean {
  if (result.ok) {
    return true;
  }
  return result.challenge !== undefined || result.mfa !== undefined;
}

/**
 * Whether `verifyPasswordForSensitiveAction()` had its password accepted:
 * tokens or a proving challenge (`ok`), or `NEW_PASSWORD_REQUIRED` — refused
 * as proof for a sensitive action, but still a password Cognito accepted,
 * exactly as `login()` treats it. `incorrect` and `unavailable` keep the slot
 * spent.
 */
export function passwordProofAccepted(check: PasswordCheckResult): boolean {
  return check.ok || check.failure === "challenge";
}
