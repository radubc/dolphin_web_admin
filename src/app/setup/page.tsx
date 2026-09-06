import type { Metadata } from "next";
import { Alert } from "antd";
import AuthShell from "@/components/auth-shell";
import { Paragraph } from "@/components/typography";
import { requireSession } from "@/lib/auth/require-session";

export const metadata: Metadata = {
  title: "Setup required · Penny Squeeze Admin",
};

/**
 * Shown when the admin database has no `admin_*` tables yet: every access
 * check would otherwise fail with a Postgres "relation does not exist".
 * Signed-in only, so the instructions are not public.
 */
export default async function SetupPage() {
  await requireSession();

  return (
    <AuthShell
      heading="Admin database not set up"
      description="The admin database is reachable, but the access-control tables are missing."
    >
      <Alert
        type="warning"
        showIcon
        title="Run the SQL scripts, then reload."
        description={
          <Paragraph style={{ marginBottom: 0 }}>
            In pgAdmin, run <code>docs/sql/001_admin_access.sql</code>,{" "}
            <code>002_access_map_and_services.sql</code> and{" "}
            <code>003_bootstrap_owner.sql</code> against the admin database, in that
            order. Alternatively set <code>ADMIN_ACCESS_STORE=mock</code> in{" "}
            <code>.env</code> to use the in-memory mock while developing.
          </Paragraph>
        }
      />
    </AuthShell>
  );
}
