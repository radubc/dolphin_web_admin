"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isTooManyRequestsError } from "@/lib/api/errors";
import { signInWithPassword } from "@/lib/auth/cognito";
import { CognitoConfigError } from "@/lib/auth/config";
import { createSession } from "@/lib/auth/session";
import {
  asString,
  EMAIL_PATTERN,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "@/lib/auth/validation";
import { clientIpFrom, ipRateLimitKey } from "@/lib/security/client-ip";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";

/**
 * Shown when either sign-in limit is hit. Says nothing about which limit, how
 * long the window is, or whether the address exists. Not exported: a
 * "use server" module may only export async functions (and types).
 */
const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many attempts. Please wait and try again.";

export interface LoginState {
  /** Non-field error, rendered as an alert above the form. */
  error?: string;
  fieldErrors?: {
    email?: string;
    password?: string;
  };
}

/**
 * Signs the user in against Cognito and starts a session.
 * Shaped for `useActionState`.
 */
export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = asString(formData.get("email")).trim();
  const password = asString(formData.get("password"));

  const fieldErrors: NonNullable<LoginState["fieldErrors"]> = {};

  if (email === "") {
    fieldErrors.email = "Enter your email address.";
  } else if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    fieldErrors.email = "Enter a valid email address.";
  }

  if (password === "") {
    fieldErrors.password = "Enter your password.";
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    fieldErrors.password = "That password is too long.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  // Before Cognito, never after: the point is to not spend a call (or an
  // account lockout) on an attempt we already know we will not honour. The
  // per-address limit is what actually stops credential stuffing, since a
  // botnet defeats the per-IP one — which is also why the per-IP limit is
  // simply skipped when no client address can be trusted, rather than counting
  // every visitor into one bucket that the first ten attempts would exhaust.
  try {
    const ipKey = ipRateLimitKey("login:ip:", clientIpFrom(await headers()));
    if (ipKey) {
      await enforceRateLimit(ipKey, RATE_LIMITS.authLogin);
    }
    await enforceRateLimit(
      `login:email:${email.toLowerCase()}`,
      RATE_LIMITS.authLoginAccount,
    );
  } catch (error) {
    if (isTooManyRequestsError(error)) {
      return { error: TOO_MANY_ATTEMPTS_MESSAGE };
    }
    throw error;
  }

  let result;
  try {
    result = await signInWithPassword(email, password);
  } catch (error) {
    // Missing/invalid Cognito environment configuration.
    console.error("[auth] Sign-in is not configured:", error);
    if (
      process.env.NODE_ENV !== "production" &&
      error instanceof CognitoConfigError
    ) {
      // Outside production, name the missing variable: it is a developer
      // setup problem, not something a user can act on. The message only ever
      // contains variable names, never their values.
      return { error: `Sign-in is not configured: ${error.message}` };
    }
    return {
      error: "Sign-in is not configured. Please contact support.",
    };
  }

  if (!result.ok) {
    return { error: result.message };
  }

  await createSession(result);

  // Throws; must stay outside the try/catch above.
  redirect("/");
}
