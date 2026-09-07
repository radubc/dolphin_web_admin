import AppShell from "@/components/shell/app-shell";
import { accessiblePages, requireAdminSession } from "@/lib/admin-access/authorize";
import { pageRegistryEntry, pageSection } from "@/lib/admin-access/page-registry";
import { capabilitiesOf } from "@/lib/admin-access/types";

/**
 * Frame for every authenticated page.
 *
 * The route group `(app)` adds no URL segment: `/`, `/constants`, `/customers`
 * and the rest all sit at the top level and simply share this layout, which
 * is what lets the shell keep its state across tab changes.
 *
 * `requireAdminSession` verifies the Cognito session *and* the allowlist; the
 * access map then decides which pages and quick actions this operator gets.
 * That is presentation: every page re-checks its own rule with
 * `requirePageAccess`, because a layout does not re-run for every navigation.
 *
 * The allowed pages are split two ways before the shell sees them. *Whether* a
 * page is in either list is the access map's answer; *which* list it lands in
 * is the `section` field of the page registry — the rail for `main`, the nav
 * bar's gear menu for `settings`. Moving a page between them is a build
 * decision and never changes its route or its rule.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { session, principal } = await requireAdminSession();
  const pages = await accessiblePages(principal);

  const routable = pages.filter((page) => page.kind === "page" && page.path !== null);

  const tabs = routable
    .filter((page) => pageSection(page.key) === "main")
    .map((page) => ({ key: page.key, href: page.path!, label: page.name }));

  const settingsEntries = routable
    .filter((page) => pageSection(page.key) === "settings")
    .map((page) => ({
      key: page.key,
      href: page.path!,
      label: page.name,
      description: page.description ?? pageRegistryEntry(page.key)?.description ?? "",
    }));

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
      settingsEntries={settingsEntries}
      quickActions={quickActions}
    >
      {children}
    </AppShell>
  );
}
