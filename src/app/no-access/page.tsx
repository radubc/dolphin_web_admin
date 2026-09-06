import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "antd";
import AuthShell from "@/components/auth-shell";
import { resolvePrincipal } from "@/lib/admin-access/authorize";
import { LOGOUT_PATH } from "@/lib/auth/cookies";
import { requireSession } from "@/lib/auth/require-session";

export const metadata: Metadata = {
  title: "No access · Penny Squeeze Admin",
};

/**
 * Where a signed-in person lands when their Cognito user has no enabled row in
 * `admin_users`. Authentication succeeded; authorization did not.
 *
 * Deliberately says nothing about *why* — not on the list, or disabled — and
 * offers only sign-out. Someone who does have access (the row was added after
 * they arrived here) is sent back in.
 */
export default async function NoAccessPage() {
  const session = await requireSession();
  if (await resolvePrincipal(session)) {
    redirect("/");
  }

  return (
    <AuthShell
      heading="You don't have access"
      description={
        <>
          {session.email ?? "This account"} is signed in, but it is not an
          operator of the Penny Squeeze admin console. Ask a super-admin to add
          you, then sign in again.
        </>
      }
    >
      {/* A real form POST, as in the user menu: the refresh cookie is scoped to
          /api/auth and only travels on a navigation there. */}
      <form action={LOGOUT_PATH} method="post">
        <Button type="primary" htmlType="submit" block size="large">
          Sign out
        </Button>
      </form>
    </AuthShell>
  );
}
