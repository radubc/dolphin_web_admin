/**
 * The pages and quick actions the code ships, keyed the same way as the
 * `admin_pages` rows in the admin database.
 *
 * This is deliberately *not* the access map. The database decides who may
 * open each entry (required actions, super-admin only, enabled, order); this
 * list only says what exists in the build, so the Access Map page can show an
 * entry that has no row yet and offer to register it with these defaults.
 * Icons and colours live in `src/components/shell/definitions.ts`, keyed by
 * the same `key`, because this module must stay importable from the server.
 *
 * Adding a page: add a route under `src/app/(app)/`, add an entry here, add
 * its icon to the shell definitions, then register it on the Access Map (or
 * in a numbered SQL file under `docs/sql/`).
 */
import type { ActionKey } from "./types";

export type PageKind = "page" | "quick_action";

/**
 * Where the shell draws an entry: the left rail (`main`) or the nav bar's gear
 * menu (`settings`).
 *
 * Deliberately in code and not in the database, unlike everything else about a
 * page. The access map still decides *who* may open an entry and in what order
 * it is listed; the section only decides *where* it is drawn, which is a
 * layout decision the build owns — moving User Management into the gear menu
 * changes nothing about its route, its key or its rule.
 *
 * Quick actions have no place of their own, so theirs is always `main`.
 */
export type PageSection = "main" | "settings";

export interface PageRegistryEntry {
  key: string;
  kind: PageKind;
  /** Route for pages; null for quick actions. */
  path: string | null;
  name: string;
  description: string;
  /** Where the shell draws it. See `PageSection`. */
  section: PageSection;
  /** Defaults used when the entry is registered from the Access Map. */
  defaults: {
    navOrder: number;
    requireSuperAdmin: boolean;
    /** ANY-OF. Empty means any operator. */
    actionKeys: ActionKey[];
  };
}

export const PAGE_REGISTRY: readonly PageRegistryEntry[] = [
  {
    key: "overview",
    kind: "page",
    path: "/",
    name: "Overview",
    description: "Landing page after sign-in.",
    section: "main",
    defaults: { navOrder: 10, requireSuperAdmin: false, actionKeys: [] },
  },
  {
    key: "constants",
    kind: "page",
    path: "/constants",
    name: "Constants",
    description: "Reference data shared by every tenant.",
    section: "main",
    defaults: {
      navOrder: 20,
      requireSuperAdmin: false,
      actionKeys: ["can_read_catalogs", "can_write_catalogs"],
    },
  },
  {
    key: "integrations",
    kind: "page",
    path: "/integrations",
    name: "Integrations",
    description:
      "External providers: catalog downloads, quotes and exchange rates, and when they run.",
    section: "main",
    defaults: {
      navOrder: 25,
      requireSuperAdmin: false,
      actionKeys: ["can_read_integrations", "can_write_integrations"],
    },
  },
  {
    key: "customers",
    kind: "page",
    path: "/customers",
    name: "Customers",
    description:
      "The consumer app's users: who they are, how active they are, and the invitations sent to them.",
    section: "main",
    defaults: {
      navOrder: 30,
      requireSuperAdmin: false,
      actionKeys: ["can_read_user_list", "can_read_user_detail", "can_invite_users"],
    },
  },
  {
    key: "cost_center",
    kind: "page",
    path: "/cost-center",
    name: "Cost center",
    description: "AWS spend, cost per client, and later Plaid and Stripe charges.",
    section: "main",
    defaults: { navOrder: 32, requireSuperAdmin: true, actionKeys: [] },
  },
  {
    key: "sales_billing",
    kind: "page",
    path: "/sales-billing",
    name: "Sales and Billing",
    description: "Subscriptions, invoices and revenue. Not built yet.",
    section: "main",
    defaults: { navOrder: 34, requireSuperAdmin: true, actionKeys: [] },
  },
  {
    key: "marketing",
    kind: "page",
    path: "/marketing",
    name: "Marketing",
    description: "Campaigns and acquisition. Not built yet.",
    section: "main",
    defaults: { navOrder: 36, requireSuperAdmin: true, actionKeys: [] },
  },
  {
    key: "user_management",
    kind: "page",
    path: "/user-management",
    name: "User Management",
    description: "Operators, roles, grants and the audit trail.",
    section: "settings",
    defaults: {
      navOrder: 30,
      requireSuperAdmin: false,
      actionKeys: ["can_manage_admin_users", "can_manage_roles", "can_read_admin_audit"],
    },
  },
  {
    key: "support",
    kind: "page",
    path: "/support",
    name: "Support",
    description: "Support tickets and the help desk.",
    section: "main",
    defaults: { navOrder: 40, requireSuperAdmin: false, actionKeys: ["can_access_tickets"] },
  },
  {
    key: "access_map",
    kind: "page",
    path: "/access-map",
    name: "Access Map",
    description: "Which actions gate each page, quick action and API endpoint.",
    section: "main",
    defaults: { navOrder: 50, requireSuperAdmin: false, actionKeys: ["can_manage_access_map"] },
  },
  {
    key: "services",
    kind: "page",
    path: "/services",
    name: "Services",
    description: "API endpoint catalog: purpose, limits and usage.",
    section: "main",
    defaults: { navOrder: 60, requireSuperAdmin: false, actionKeys: ["can_read_services"] },
  },
  {
    key: "invite_user",
    kind: "quick_action",
    path: null,
    name: "Invite user",
    description: "Add an operator to the admin pool.",
    section: "main",
    defaults: { navOrder: 10, requireSuperAdmin: true, actionKeys: [] },
  },
  {
    key: "invite_customer",
    kind: "quick_action",
    path: null,
    name: "Invite customer",
    description: "Create a consumer-app account and email the invitation.",
    section: "main",
    defaults: { navOrder: 20, requireSuperAdmin: false, actionKeys: ["can_invite_users"] },
  },
] as const;

export type PageKey = (typeof PAGE_REGISTRY)[number]["key"];

export function pageRegistryEntry(key: string): PageRegistryEntry | undefined {
  return PAGE_REGISTRY.find((entry) => entry.key === key);
}

/**
 * Where the shell draws an entry. Anything the running build does not ship
 * falls back to the rail, which is the section every entry had before the gear
 * menu existed.
 */
export function pageSection(key: string): PageSection {
  return pageRegistryEntry(key)?.section ?? "main";
}

/** The registry entry whose route matches `pathname`, longest prefix first. */
export function pageForPath(pathname: string): PageRegistryEntry | undefined {
  return PAGE_REGISTRY.filter((entry) => entry.path !== null)
    .filter((entry) =>
      entry.path === "/" ? pathname === "/" : pathname === entry.path || pathname.startsWith(`${entry.path}/`),
    )
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0];
}
