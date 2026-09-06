"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isTooManyRequestsError } from "@/lib/api/errors";
import {
  confirmPasswordReset as confirmResetWithCognito,
  GENERIC_RESET_ERROR,
  requestPasswordReset as requestResetFromCognito,
} from "@/lib/auth/cognito";
import { CognitoConfigError } from "@/lib/auth/config";
import {
  asString,
  EMAIL_PATTERN,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "@/lib/auth/validation";
import { clientIpFrom, ipRateLimitKey } from "@/lib/security/client-ip";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";

/**
 * Shown after step one whatever Cognito actually did, so the form never
 * reveals whether an account exists for the address. Not exported: a
 * "use server" module may only export async functions (and types).
 */
const RESET_CODE_SENT_MESSAGE =
  "If an account exists for that email, we've sent a verification code.";

/**
 * Shown when a reset limit is hit. Deliberately vague: naming the window, or
 * differing between the per-address and per-IP limit, would turn the form into
 * an oracle. Not exported, for the same reason as the message above.
 */
const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many attempts. Please wait and try again.";

export interface RequestResetState {
  /** True once step one has run: the client advances to the code step. */
  sent?: boolean;
  /** Neutral confirmation copy, present whenever `sent` is true. */
  message?: string;
  /** The validated address, handed to step two. */
  email?: string;
  /** Non-field error, rendered as an alert above the form. */
  error?: string;
  fieldErrors?: {
    email?: string;
  };
}

export interface ConfirmResetState {
  /** Non-field error, rendered as an alert above the form. */
  error?: string;
  fieldErrors?: {
    code?: string;
    password?: string;
    confirm?: string;
  };
  /** The code cannot work any more: offer a way back to step one. */
  allowResend?: boolean;
}

/** Cognito codes are six digits, but the field length is not ours to police. */
const MAX_CODE_LENGTH = 64;

function validateEmail(email: string): string | undefined {
  if (email === "") {
    return "Enter your email address.";
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return "Enter a valid email address.";
  }
  return undefined;
}

/**
 * Message for an error that escaped the Cognito helpers.
 *
 * A `CognitoConfigError` means the environment is not set up, which no visitor
 * can act on; anything else is an unexpected failure and gets the same generic
 * text the helpers use, so a stray SDK message never reaches the page.
 */
function describeUnhandled(error: unknown): string {
  if (!(error instanceof CognitoConfigError)) {
    console.error("[auth] Unexpected password reset error:", error);
    return GENERIC_RESET_ERROR;
  }

  console.error("[auth] Password reset is not configured:", error);
  if (process.env.NODE_ENV !== "production") {
    // Outside production, name the missing variable: it is a developer setup
    // problem, not something a user can act on. The message only ever contains
    // variable names, never their values.
    return `Password reset is not configured: ${error.message}`;
  }
  return "Password reset is not configured. Please contact support.";
}

/**
 * Consumes the reset budget for this caller, and for `email` when given.
 *
 * Always called before Cognito: a reset request costs a real email, and the
 * confirm step is a guess at a six-digit code, so neither may be attempted on a
 * caller that is already over budget.
 *
 * The per-IP policy is skipped when no client address can be trusted: one
 * bucket shared by every visitor would let five requests anywhere disable
 * password resets for everyone. The per-address policy is unaffected.
 *
 * @returns the neutral refusal message when the caller is limited, otherwise
 * `undefined`.
 */
async function checkResetRateLimit(email?: string): Promise<string | undefined> {
  try {
    const ipKey = ipRateLimitKey("reset:ip:", clientIpFrom(await headers()));
    if (ipKey) {
      await enforceRateLimit(ipKey, RATE_LIMITS.authReset);
    }
    if (email !== undefined) {
      await enforceRateLimit(
        `reset:email:${email.toLowerCase()}`,
        RATE_LIMITS.authReset,
      );
    }
    return undefined;
  } catch (error) {
    if (isTooManyRequestsError(error)) {
      return TOO_MANY_ATTEMPTS_MESSAGE;
    }
    throw error;
  }
}

/**
 * Step one: ask Cognito to email a reset code.
 * Shaped for `useActionState`.
 */
export async function requestPasswordReset(
  _prevState: RequestResetState,
  formData: FormData,
): Promise<RequestResetState> {
  const email = asString(formData.get("email")).trim();

  const emailError = validateEmail(email);
  if (emailError) {
    return { fieldErrors: { email: emailError } };
  }

  // Per IP only. A per-address limit here would answer "has this address been
  // asked for recently?", which is exactly the enumeration signal the neutral
  // confirmation message exists to hide.
  const limited = await checkResetRateLimit();
  if (limited) {
    return { error: limited };
  }

  let result;
  try {
    result = await requestResetFromCognito(email);
  } catch (error) {
    return { error: describeUnhandled(error) };
  }

  if (!result.ok) {
    return { error: result.error };
  }

  return { sent: true, message: RESET_CODE_SENT_MESSAGE, email };
}

/**
 * Step two: exchange the code plus a new password for a reset.
 * Shaped for `useActionState`. Redirects to /login on success.
 */
export async function confirmPasswordReset(
  _prevState: ConfirmResetState,
  formData: FormData,
): Promise<ConfirmResetState> {
  // Carried in a hidden field from step one; never trusted, always re-checked.
  const email = asString(formData.get("email")).trim();
  const code = asString(formData.get("code")).trim();
  const password = asString(formData.get("password"));
  const confirm = asString(formData.get("confirm"));

  if (validateEmail(email)) {
    return {
      error: "We lost track of that reset. Request a new code to start again.",
      allowResend: true,
    };
  }

  const fieldErrors: NonNullable<ConfirmResetState["fieldErrors"]> = {};

  if (code === "") {
    fieldErrors.code = "Enter the code from the email.";
  } else if (code.length > MAX_CODE_LENGTH) {
    fieldErrors.code = "That code isn't right. Check the email and try again.";
  }

  if (password === "") {
    fieldErrors.password = "Enter a new password.";
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    fieldErrors.password = "That password is too long.";
  }

  if (confirm === "") {
    fieldErrors.confirm = "Re-enter the new password.";
  } else if (password !== "" && confirm !== password) {
    fieldErrors.confirm = "Both passwords must match.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  // Per IP and per address: by this point the address is one the caller already
  // claimed to own, so limiting it leaks nothing, and it is what caps guesses at
  // the code for a single account.
  const limited = await checkResetRateLimit(email);
  if (limited) {
    return { error: limited };
  }

  let result;
  try {
    result = await confirmResetWithCognito(email, code, password);
  } catch (error) {
    return { error: describeUnhandled(error) };
  }

  if (!result.ok) {
    if (result.field === "code" || result.field === "password") {
      return {
        fieldErrors: { [result.field]: result.error },
        allowResend: result.resend,
      };
    }
    return { error: result.error, allowResend: result.resend };
  }

  // Throws; must stay outside the try/catch above.
  redirect("/login?reset=success");
}
