import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert } from "antd";
import AuthShell from "@/components/auth-shell";
import {
  EXPIRED_SESSION_PARAM,
  IDLE_SESSION_VALUE,
  IDLE_TIMEOUT_SECONDS,
} from "@/lib/auth/cookies";
import { verifySession } from "@/lib/auth/session";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Penny Squeeze Admin",
  description: "Sign in to the Penny Squeeze admin console.",
};

/** Set by the password reset flow on its way back here. */
const RESET_PARAM = "reset";
const RESET_SUCCESS = "success";

/** Minutes of inactivity that end a session, for the notice below. */
const IDLE_TIMEOUT_MINUTES = Math.round(IDLE_TIMEOUT_SECONDS / 60);

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const session = await verifySession();
  if (session) {
    redirect("/");
  }

  // `searchParams` is a promise in Next 16.
  const { [RESET_PARAM]: reset, [EXPIRED_SESSION_PARAM]: sessionNotice } =
    await searchParams;
  // A repeated param arrives as an array, which is not `RESET_SUCCESS`.
  const passwordWasReset = reset === RESET_SUCCESS;
  // `?session=idle`: the refresh endpoint or the keepalive ended the session
  // because nothing happened in this browser for half an hour. (`expired` is
  // the proxy's business — it clears the stale cookies and redirects here
  // without the parameter, so there is nothing to say about it.)
  const wasIdle = sessionNotice === IDLE_SESSION_VALUE;

  return (
    <AuthShell
      heading="Sign in to your account"
      description="Use your Penny Squeeze admin email and password, or a passkey, to continue."
    >
      {wasIdle ? (
        <Alert
          type="info"
          showIcon
          title={`You were signed out after ${IDLE_TIMEOUT_MINUTES} minutes of inactivity.`}
          description="Sign in again to continue."
          role="status"
          style={{ marginBottom: 20 }}
        />
      ) : null}
      {passwordWasReset ? (
        <Alert
          type="success"
          showIcon
          title="Your password has been reset. Sign in with your new password."
          role="status"
          style={{ marginBottom: 20 }}
        />
      ) : null}
      <LoginForm />
    </AuthShell>
  );
}
