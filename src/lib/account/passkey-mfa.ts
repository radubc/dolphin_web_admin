import "server-only";
/**
 * Keeps passkey sign-in working for an operator who has an authenticator app
 * (docs/two-factor-plan.md, phase A; a port of the web app's phase 1).
 *
 * Cognito refuses a passkey sign-in to an account with TOTP on unless the pool
 * is `MULTI_FACTOR_WITH_USER_VERIFICATION` *and* the user has
 * `WebAuthnMfaSettings` on; then a passkey with user verification counts as
 * both factors and password sign-in still asks for the code. The per-user flag
 * is only allowed while another factor is on, so it is switched on exactly when
 * the account has TOTP on and at least one passkey:
 *
 * - after the authenticator app is turned on (`PUT /api/v1/admin/me/mfa/totp`);
 * - after a passkey is registered (`PUT /api/v1/admin/me/passkeys`);
 * - after a password sign-in answers the authenticator code (`verifyMfaCode`
 *   in `src/app/login/actions.ts`), which heals operators who had both before
 *   this existed. `GET /api/v1/admin/me/mfa` only reads; it never sets the flag.
 *
 * **Best-effort, always.** A pool without the factor configuration refuses the
 * call; that is logged as a warning (`passkeyMfaRefused` in `./service.ts`) and
 * never fails the enrolment, registration or sign-in that triggered it.
 * Nothing here throws.
 */
import { getMfaStatus, listPasskeys, setPasskeyMfaPreference } from "./service";
import type { MfaStatus } from "./types";

/**
 * The three Cognito calls the check can make, so the tests can stub them
 * (`./passkey-mfa.test.ts`); production callers pass nothing and get the
 * real functions from `./service`.
 */
export interface PasskeyMfaGateway {
  getMfaStatus: typeof getMfaStatus;
  listPasskeys: typeof listPasskeys;
  setPasskeyMfaPreference: typeof setPasskeyMfaPreference;
}

const defaultGateway: PasskeyMfaGateway = { getMfaStatus, listPasskeys, setPasskeyMfaPreference };

/** What the caller already knows; anything left out is read from Cognito. */
export interface PasskeyMfaFacts {
  status?: Pick<MfaStatus, "totpEnabled" | "passkeyMfaEnabled">;
  hasPasskeys?: boolean;
}

export interface PasskeyMfaCheck {
  /** Passkey MFA is on after the check (already, or switched on now). */
  passkeyMfaEnabled: boolean;
  /**
   * TOTP is on, a passkey exists, and passkey MFA could not be switched on:
   * Cognito will refuse this account a passkey sign-in until it can.
   */
  passkeySignInPaused: boolean;
}

/**
 * Switches passkey MFA on when the account needs it. `GetUser` and
 * `ListWebAuthnCredentials` run only for facts the caller did not supply (the
 * list only once TOTP is known to be on and passkey MFA off), and
 * `SetUserMFAPreference` only when a passkey exists.
 */
export async function ensurePasskeyMfa(
  accessToken: string,
  facts: PasskeyMfaFacts = {},
  gateway: PasskeyMfaGateway = defaultGateway,
): Promise<PasskeyMfaCheck> {
  const unchanged = (passkeyMfaEnabled: boolean): PasskeyMfaCheck => ({
    passkeyMfaEnabled,
    passkeySignInPaused: false,
  });
  try {
    let status = facts.status;
    let hasPasskeys = facts.hasPasskeys;
    if (status === undefined) {
      const read = await gateway.getMfaStatus(accessToken);
      status = read;
      // That read already lists the passkeys for exactly the case handled
      // below (TOTP on, flag off) and reports a failed list as "not paused",
      // so its answer is reused rather than asked for again.
      hasPasskeys ??= read.passkeySignInPaused;
    }
    if (!status.totpEnabled || status.passkeyMfaEnabled) {
      return unchanged(status.passkeyMfaEnabled);
    }

    if (hasPasskeys === undefined) {
      hasPasskeys = (await gateway.listPasskeys(accessToken)).length > 0;
    }
    if (!hasPasskeys) {
      return unchanged(false);
    }

    try {
      await gateway.setPasskeyMfaPreference(accessToken, true);
    } catch {
      // Already logged with Cognito's error name by `passkeyMfaRefused`.
      return { passkeyMfaEnabled: false, passkeySignInPaused: true };
    }
    return { passkeyMfaEnabled: true, passkeySignInPaused: false };
  } catch (error) {
    // A failed read or list (already logged by the service), or a missing
    // ADMIN_COGNITO_* variable; the triggering call has already succeeded, so
    // it is reported and swallowed.
    console.warn("[account] passkey MFA check skipped.", error);
    return unchanged(false);
  }
}
