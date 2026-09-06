import AppShell from "@/components/shell/app-shell";
import { accessiblePages, requireAdminSession } from "@/lib/admin-access/authorize";
import { pageRegistryEntry } from "@/lib/admin-access/page-registry";
import { capabilitiesOf } from "@/lib/admin-access/types";

/**
 * Frame for every authenticated page.
 *
 * The route group `(app)` adds no URL segment: `/`, `/constants`, `/user-management`
 * and the rest all sit at the top level and simply share this layout, which
 * is what lets the shell keep its state across tab changes.
 *
 * `requireAdminSession` verifies the Cognito session *and* the allowlist; the
 * access map then decides which rail tabs and quick actions this operator
 * gets. That is presentation: every page re-checks its own rule with
 * `requirePageAccess`, because a layout does not re-run for every navigation.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { session, principal } = await requireAdminSession();
  const pages = await accessiblePages(principal);

  const tabs = pages
    .filter((page) => page.kind === "page" && page.path !== null)
    .map((page) => ({ key: page.key, href: page.path!, label: page.name }));

  const quickActions = pages
    .filter((page) => page.kind === "quick_action")
    .map((page) => ({
      key: page.key,
      title: page.name,
      subtitle: page.description ?? pageRegistryEntry(page.key)?.description ?? "",
    }));

  return (
    <AppShell
      email={session.email}
      name={principal.user.displayName ?? session.name}
      capabilities={capabilitiesOf(principal)}
      tabs={tabs}
      quickActions={quickActions}
    >
      {children}
    </AppShell>
  );
}
