/**
 * The decision behind a recovery-code sign-in (`docs/two-factor-plan.md`,
 * phase B; the design is the consumer app's `docs/recovery-codes.md`,
 * section 3), separated from the Server Action so the ordering can be tested
 * against a stubbed {@link RecoveryRedeemGateway} without Next, Cognito or a
 * database (`./recovery-redeem.test.ts`).
 *
 * The action (`redeemRecoveryCode` in `src/app/login/actions.ts`) owns what
 * needs the request: field validation, both rate limits, the session cookies
 * and the redirects. This module owns the order of everything after that:
 *
 * 1. **Password**: proven for the typed address. A challenge is proof; tokens
 *    (no second factor asked — the authenticator was turned off since the
 *    code step appeared, by support say) and `NEW_PASSWORD_REQUIRED` both
 *    send the person back to step one, where the ordinary sign-in takes over.
 * 2. **Who**: the pool account looked up by **the address the password was
 *    just proven for** — never by the hidden `username` the browser posted —
 *    and the `admin_users` row by its `sub`, which must be enabled.
 * 3. **Claim first**: one atomic statement, so two requests carrying the same
 *    code cannot both pass, and a failed claim costs nothing.
 * 4. **Cognito off**, with the claim undone on a refusal so the code is not
 *    spent on a recovery that did not happen.
 * 5. **The other codes go**, best effort; the redeemed row stays as the
 *    record the drawer banner and the shell notice are built from.
 * 6. **Sign in** with the same password: with the factor off Cognito now
 *    returns tokens. The action writes the session and redirects.
 *
 * Every verdict about the person — wrong password, unknown or disabled
 * account, no matching unused code — is the same `neutral` outcome, so the
 * recovery form is not an oracle for any one of them. An AWS or database
 * fault is `unavailable`, never `neutral`: a judgement never made is not a
 * verdict. Logging names ids and Cognito error names only; never the address,
 * the password, the code or its hash.
 */
import type { PasswordCheckResult, SignInResult } from "./cognito";
import type { AdminFindUserResult, AdminTurnOffSecondFactorResult } from "./cognito-admin";

/** What the action has established before this module runs. */
export interface RecoveryRedeemInput {
  /** The typed address, validated; the password is proven for this. */
  email: string;
  password: string;
  /** The recovery code, already normalised (ten symbols, no dash). */
  code: string;
}

/** The calls the decision makes, in the order it makes them. */
export interface RecoveryRedeemGateway {
  verifyPassword(email: string, password: string): Promise<PasswordCheckResult>;
  findPoolUser(email: string): Promise<AdminFindUserResult>;
  /** The enabled `admin_users` row for a pool `sub`, or null. */
  findEnabledOperatorBySub(sub: string): Promise<{ id: string } | null>;
  hashCode(normalised: string): string;
  claimCode(operatorId: string, codeHash: string): Promise<boolean>;
  unclaimCode(operatorId: string, codeHash: string): Promise<void>;
  deleteOtherCodes(operatorId: string, keepCodeHash: string): Promise<number>;
  turnOffSecondFactor(poolUsername: string): Promise<AdminTurnOffSecondFactorResult>;
  signIn(email: string, password: string): Promise<SignInResult>;
}

export type RecoveryRedeemOutcome =
  /** Wrong password, unknown or disabled account, or no matching unused code. */
  | { kind: "neutral" }
  /** AWS or the database could not be reached or refused; nothing was judged. */
  | { kind: "unavailable" }
  /** The step cannot continue (no second factor, or a temporary password): step one. */
  | { kind: "restart" }
  /** Cognito refused to turn the factor off; the code was put back. */
  | { kind: "turn_off_refused" }
  /**
   * The factor is off. `signIn` is what the password alone then produced:
   * tokens normally; a challenge or a refusal when Cognito has not caught up,
   * in which case the password alone works on the next attempt.
   */
  | { kind: "recovered"; operatorId: string; signIn: SignInResult };

/**
 * Runs the decision. Throws only what the gateway throws for configuration
 * (`CognitoConfigError`), which the action turns into "not configured".
 */
export async function decideRecoveryRedeem(
  input: RecoveryRedeemInput,
  gateway: RecoveryRedeemGateway,
): Promise<RecoveryRedeemOutcome> {
  const { email, password, code } = input;

  const proven = await gateway.verifyPassword(email, password);
  if (!proven.ok) {
    if (proven.failure === "unavailable") return { kind: "unavailable" };
    if (proven.failure === "challenge") {
      // `NEW_PASSWORD_REQUIRED`: a temporary password, which cannot have an
      // authenticator behind it. Back to step one, where the set-password
      // step takes over.
      return { kind: "restart" };
    }
    return { kind: "neutral" };
  }
  if (proven.proof === "tokens") {
    // No second factor was asked: the authenticator is already off. The
    // tokens are not used — that function's contract says callers must not
    // depend on them — the person signs in normally instead.
    return { kind: "restart" };
  }

  // Who. The address the password was proven for, and only that; the module
  // behind `findPoolUser` also checks the answer's email attribute.
  const found = await gateway.findPoolUser(email);
  if (!found.ok) return { kind: "unavailable" };
  if (found.user === null) return { kind: "neutral" };

  let operator: { id: string } | null;
  try {
    operator = await gateway.findEnabledOperatorBySub(found.user.sub);
  } catch (error) {
    // A database fault is not a verdict on the password or the code.
    console.error("[auth] recovery: the admin_users row could not be read.", error);
    return { kind: "unavailable" };
  }
  if (operator === null) {
    // Not on the allowlist, or switched off: nothing to recover into.
    return { kind: "neutral" };
  }

  // Claim first: one atomic statement, so two requests carrying the same code
  // cannot both pass, and a failed claim costs nothing.
  const codeHash = gateway.hashCode(code);
  let claimed: boolean;
  try {
    claimed = await gateway.claimCode(operator.id, codeHash);
  } catch (error) {
    console.error(`[auth] operator ${operator.id}: a recovery code could not be claimed.`, error);
    return { kind: "unavailable" };
  }
  if (!claimed) return { kind: "neutral" };

  let turnedOff: AdminTurnOffSecondFactorResult | null;
  try {
    turnedOff = await gateway.turnOffSecondFactor(found.user.username);
  } catch (error) {
    turnedOff = null;
    console.error(`[auth] operator ${operator.id}: recovery could not reach Cognito.`, error);
  }
  if (turnedOff === null || !turnedOff.ok) {
    // The refusal is logged with the permission name by the admin module. Put
    // the code back so it is not spent on a recovery that did not happen.
    try {
      await gateway.unclaimCode(operator.id, codeHash);
    } catch (error) {
      console.error(
        `[auth] operator ${operator.id}: a recovery code was claimed, Cognito refused to turn the factor off, and the claim could NOT be undone. The person is down one code of ten.`,
        error,
      );
    }
    return { kind: "turn_off_refused" };
  }
  console.info(`[auth] operator ${operator.id}: two-factor authentication turned off with a recovery code.`);

  // The factor is off; the other codes go, best effort. A failure here leaves
  // spent-looking codes behind until the next enrolment replaces them.
  try {
    await gateway.deleteOtherCodes(operator.id, codeHash);
  } catch (error) {
    console.error(
      `[auth] operator ${operator.id}: the remaining recovery codes could not be deleted after a recovery.`,
      error,
    );
  }

  // With the factor off Cognito now returns tokens for the same password.
  const signIn = await gateway.signIn(email, password);
  if (!signIn.ok) {
    console.warn(
      `[auth] operator ${operator.id}: sign-in after the recovery did not produce tokens (${
        signIn.challenge?.name ?? signIn.mfa?.name ?? "refused"
      }).`,
    );
  }
  return { kind: "recovered", operatorId: operator.id, signIn };
}
