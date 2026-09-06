import type { Metadata } from "next";
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
  // Only a person with *no* allowlist row stays here; an operator refused by
  // one page's rule still has Overview and their other pages.
  let principal = null;
  try {
    principal = await resolvePrincipal(session);
  } catch {
    principal = null;
  }
  const allowlisted = principal !== null;

  return (
    <AuthShell
      heading="You don't have access"
      description={
        <>
          {session.email ?? "This account"} is signed in, but it is either not an
          operator of the Penny Squeeze admin console or not allowed to open that
          page. Ask a super-admin to add you or grant the role, then try again.
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {allowlisted ? (
          <Button type="primary" href="/" block size="large">
            Back to Overview
          </Button>
        ) : null}
        {/* A real form POST, as in the user menu: the refresh cookie is scoped to
            /api/auth and only travels on a navigation there. */}
        <form action={LOGOUT_PATH} method="post">
          <Button type={allowlisted ? "default" : "primary"} htmlType="submit" block size="large">
            Sign out
          </Button>
        </form>
      </div>
    </AuthShell>
  );
}
