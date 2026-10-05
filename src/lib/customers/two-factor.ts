import "server-only";
/**
 * Support's "Turn off two-factor authentication" for a customer
 * (`docs/two-factor-plan.md`, phase C; the brief is the web repo's
 * `docs/admin-console/two-factor-reset.md`).
 *
 * The support case: a person has lost both their authenticator app and their
 * recovery codes. The console makes one Cognito admin call on the **customer**
 * pool that switches their second factor off (`resetTwoFactor` in
 * `./cognito.ts`); they sign in with their password alone and enrol again in
 * the consumer app, which issues them new recovery codes. Nothing else about
 * the account changes, and the consumer app's `user_recovery_codes` table is
 * never read or written from here — it is the web app's, and the next
 * enrolment replaces the rows.
 *
 * Four guards, in the order they are applied:
 *
 * 1. **The operator's own session must have been signed in with a second
 *    factor** (`password+totp` or `passkey`, recorded at sign-in — see
 *    `SignInMethod` in `src/lib/auth/session.ts`). A password-only session is
 *    refused with 403 before anything is counted or called; the drawer shows
 *    the same sentence instead of the button.
 * 2. **Rate limit**, 5 per hour per operator, charged before Cognito.
 * 3. The customer must exist (404) and the pool must be configured (503).
 * 4. **Audit**: one `admin_permission_audit_events` row per attempt that
 *    reached Cognito, done or failed, with the factors the account had before.
 *    Best effort, like the invitation audit: a database that has not had
 *    `docs/sql/021` run must not turn a successful reset into a 500.
 *
 * Logging names the customer's `sub` and Cognito's error name, never the
 * address.
 */
import { Prisma } from "@/generated/prisma-admin/client";
import { ApiError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "@/lib/api/errors";
import { isSecondFactorSignIn, type SignInMethod } from "@/lib/auth/sign-in-method";
import { prismaAdmin } from "@/lib/prisma-admin";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";
import { COGNITO_UNAVAILABLE, availability, readTwoFactor, resetTwoFactor } from "./cognito";
import { findCustomerById } from "./repository";
import {
  SECOND_FACTOR_REQUIRED_MESSAGE,
  type CustomerTwoFactor,
  type CustomerTwoFactorResetResponse,
} from "./types";

/**
 * What the reset reaches for — the customer row, the pool and the audit
 * table — so the order of the guards can be tested against stubs
 * (`./two-factor.test.ts`). The rate limiter is not here: it is in-process
 * and the tests exercise the real one. Production callers pass nothing.
 */
export interface TwoFactorResetGateway {
  findCustomerById: typeof findCustomerById;
  availability: typeof availability;
  readTwoFactor: (sub: string) => Promise<CustomerTwoFactor>;
  resetTwoFactor: (sub: string) => Promise<void>;
  /** The raw audit insert; `recordTwoFactorAudit` catches whatever it throws. */
  writeAudit: (data: Prisma.admin_permission_audit_eventsUncheckedCreateInput) => Promise<unknown>;
}

const defaultGateway: TwoFactorResetGateway = {
  findCustomerById,
  availability,
  readTwoFactor: (sub) => readTwoFactor(sub),
  resetTwoFactor: (sub) => resetTwoFactor(sub),
  writeAudit: (data) => prismaAdmin.admin_permission_audit_events.create({ data }),
};

/** Who is asking: the allowlist row and how their session was signed in. */
export interface TwoFactorResetActor {
  /** `admin_users.id`, for the audit row and the rate-limit key. */
  userId: string;
  signInMethod: SignInMethod;
}

/** Whether this session may turn a customer's two-factor authentication off. */
export function operatorCanResetTwoFactor(signInMethod: SignInMethod): boolean {
  return isSecondFactorSignIn(signInMethod);
}

/**
 * The two-factor block for the detail read. Best effort: a pool that is not
 * configured, an account that is not there, or a call that failed all come
 * back as `null` — the drawer says "Unavailable" and the rest of the customer
 * still renders. `readTwoFactor` has already logged the real reason.
 */
export async function describeTwoFactor(
  sub: string,
  gateway: TwoFactorResetGateway = defaultGateway,
): Promise<CustomerTwoFactor | null> {
  if (!gateway.availability().canSend) return null;
  try {
    return await gateway.readTwoFactor(sub);
  } catch (error) {
    if (!(error instanceof ApiError)) {
      console.error(`[customers] two-factor read failed for sub ${sub}:`, error);
    }
    return null;
  }
}

/**
 * One audit row per attempt that reached Cognito. The metadata names the
 * factors the account had before the call (`methodsBefore`), which is the
 * one fact that cannot be recovered afterwards.
 */
async function recordTwoFactorAudit(
  actorUserId: string,
  action: "customer_two_factor_reset" | "customer_two_factor_reset_failed",
  customer: { id: string; email: string; cognitoSub: string },
  extra: Record<string, string | string[] | boolean | null>,
  gateway: TwoFactorResetGateway,
): Promise<void> {
  try {
    await gateway.writeAudit({
      actor_user_id: actorUserId,
      action,
      target_type: "customer_two_factor_reset",
      target_id: customer.id,
      metadata: {
        // `target_label` is lifted out of metadata into `AuditEvent.targetLabel`
        // by the admin-access repository.
        target_label: customer.email,
        email: customer.email,
        cognitoSub: customer.cognitoSub,
        ...extra,
      } as Prisma.InputJsonObject,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n").filter(Boolean).at(-1) : String(error);
    console.warn(`[customers] audit skipped: ${reason}`);
  }
}

/**
 * Turns the customer's two-factor authentication off and answers the block
 * re-read from the pool.
 *
 * @throws {ForbiddenError} the operator's session was signed in with a
 * password alone.
 * @throws {TooManyRequestsError} more than five in an hour from this operator.
 * @throws {NotFoundError} no such customer.
 * @throws {ServiceUnavailableError} the pool is not configured, or AWS
 * refused the call (the audit row records the failure).
 */
export async function resetCustomerTwoFactor(
  id: string,
  actor: TwoFactorResetActor,
  gateway: TwoFactorResetGateway = defaultGateway,
): Promise<CustomerTwoFactorResetResponse> {
  if (!operatorCanResetTwoFactor(actor.signInMethod)) {
    throw new ForbiddenError(SECOND_FACTOR_REQUIRED_MESSAGE);
  }
  // Before the customer lookup and before Cognito: a refused attempt still
  // spends one of the five.
  await enforceRateLimit(`two-factor-reset:user:${actor.userId}`, RATE_LIMITS.customerTwoFactorReset);

  const customer = await gateway.findCustomerById(id);
  if (customer === null) throw new NotFoundError("That customer does not exist.");

  const { canSend, reason } = gateway.availability();
  if (!canSend) {
    throw new ServiceUnavailableError(
      COGNITO_UNAVAILABLE,
      reason ?? "The customer pool cannot be reached from this deployment.",
    );
  }

  // The factors on file before the call, for the audit row. A failure here is
  // the same failure the reset itself would hit (no account, no permission),
  // so it is let through as the answer.
  const before = await gateway.readTwoFactor(customer.cognitoSub);

  try {
    await gateway.resetTwoFactor(customer.cognitoSub);
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ServiceUnavailableError(COGNITO_UNAVAILABLE, "The customer Cognito pool could not be reached. Try again shortly.");
    await recordTwoFactorAudit(actor.userId, "customer_two_factor_reset_failed", customer, {
      methodsBefore: before.methods,
      reason: apiError.code,
    }, gateway);
    throw apiError;
  }

  console.info(`[customers] two-factor authentication turned off for sub ${customer.cognitoSub}`);
  const after = await describeTwoFactor(customer.cognitoSub, gateway);
  await recordTwoFactorAudit(actor.userId, "customer_two_factor_reset", customer, {
    methodsBefore: before.methods,
    methodsAfter: after?.methods ?? null,
  }, gateway);
  return { twoFactor: after };
}
