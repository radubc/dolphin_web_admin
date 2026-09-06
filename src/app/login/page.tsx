import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert } from "antd";
import AuthShell from "@/components/auth-shell";
import { verifySession } from "@/lib/auth/session";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Penny Squeeze Admin",
  description: "Sign in to the Penny Squeeze admin console.",
};

/** Set by the password reset flow on its way back here. */
const RESET_PARAM = "reset";
const RESET_SUCCESS = "success";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const session = await verifySession();
  if (session) {
    redirect("/");
  }

  // `searchParams` is a promise in Next 16.
  const { [RESET_PARAM]: reset } = await searchParams;
  // A repeated param arrives as an array, which is not `RESET_SUCCESS`.
  const passwordWasReset = reset === RESET_SUCCESS;

  return (
    <AuthShell
      heading="Sign in to your account"
      description="Use your Penny Squeeze admin email and password to continue."
    >
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
