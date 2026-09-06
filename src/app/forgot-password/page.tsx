import type { Metadata } from "next";
import { redirect } from "next/navigation";
import AuthShell from "@/components/auth-shell";
import { verifySession } from "@/lib/auth/session";
import ForgotPasswordForm from "./forgot-password-form";

export const metadata: Metadata = {
  title: "Reset password · Penny Squeeze Admin",
  description: "Reset your Penny Squeeze admin password.",
};

export default async function ForgotPasswordPage() {
  // The proxy already keeps signed-in users away, but a page must not depend
  // on it: the cookie it reads is never verified.
  const session = await verifySession();
  if (session) {
    redirect("/");
  }

  return (
    <AuthShell
      heading="Reset your password"
      description="We'll email you a verification code, then you can choose a new password."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
