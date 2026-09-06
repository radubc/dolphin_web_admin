import AppShell from "@/components/shell/app-shell";
import { requireAdminSession } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";

/**
 * Frame for every authenticated page.
 *
 * The route group `(app)` adds no URL segment: `/`, `/constants`, `/user-management`
 * and `/support` all sit at the top level and simply share this layout, which
 * is what lets the shell keep its state across tab changes.
 *
 * `requireAdminSession` verifies the Cognito session *and* the allowlist: a
 * valid token whose `sub` has no enabled `admin_users` row lands on
 * `/no-access`. The check runs here *and* in each page. The layout's check is
 * not a security boundary on its own — a layout does not re-run for every
 * navigation — so the pages keep their own.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { session, principal } = await requireAdminSession();

  return (
    <AppShell
      email={session.email}
      name={principal.user.displayName ?? session.name}
      capabilities={capabilitiesOf(principal)}
    >
      {children}
    </AppShell>
  );
}
