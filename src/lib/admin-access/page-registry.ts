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

export interface PageRegistryEntry {
  key: string;
  kind: PageKind;
  /** Route for pages; null for quick actions. */
  path: string | null;
  name: string;
  description: string;
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
    defaults: { navOrder: 10, requireSuperAdmin: false, actionKeys: [] },
  },
  {
    key: "constants",
    kind: "page",
    path: "/constants",
    name: "Constants",
    description: "Reference data shared by every tenant.",
    defaults: {
      navOrder: 20,
      requireSuperAdmin: false,
      actionKeys: ["can_read_catalogs", "can_write_catalogs"],
    },
  },
  {
    key: "user_management",
    kind: "page",
    path: "/user-management",
    name: "User Management",
    description: "Operators, roles, grants and the audit trail.",
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
    defaults: { navOrder: 40, requireSuperAdmin: false, actionKeys: ["can_access_tickets"] },
  },
  {
    key: "access_map",
    kind: "page",
    path: "/access-map",
    name: "Access Map",
    description: "Which actions gate each page, quick action and API endpoint.",
    defaults: { navOrder: 50, requireSuperAdmin: false, actionKeys: ["can_manage_access_map"] },
  },
  {
    key: "services",
    kind: "page",
    path: "/services",
    name: "Services",
    description: "API endpoint catalog: purpose, limits and usage.",
    defaults: { navOrder: 60, requireSuperAdmin: false, actionKeys: ["can_read_services"] },
  },
  {
    key: "invite_user",
    kind: "quick_action",
    path: null,
    name: "Invite user",
    description: "Add an operator to the admin pool.",
    defaults: { navOrder: 10, requireSuperAdmin: true, actionKeys: [] },
  },
] as const;

export type PageKey = (typeof PAGE_REGISTRY)[number]["key"];

export function pageRegistryEntry(key: string): PageRegistryEntry | undefined {
  return PAGE_REGISTRY.find((entry) => entry.key === key);
}

/** The registry entry whose route matches `pathname`, longest prefix first. */
export function pageForPath(pathname: string): PageRegistryEntry | undefined {
  return PAGE_REGISTRY.filter((entry) => entry.path !== null)
    .filter((entry) =>
      entry.path === "/" ? pathname === "/" : pathname === entry.path || pathname.startsWith(`${entry.path}/`),
    )
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0];
}
