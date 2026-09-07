/**
 * Presentation of the admin shell: the icon and colour for every page and
 * quick action the code ships, keyed the same way as `admin_pages` and the
 * page registry in `src/lib/admin-access/page-registry.ts`.
 *
 * Nothing here decides *who* sees an entry or in what order: the access map in
 * the database does, and the shell receives the resolved list from the layout.
 * This module only says how to draw an entry once it is allowed.
 *
 * Data only, no JSX, so the shell's client components can share it. Icons are
 * stored as components and rendered by the consumer.
 */
import {
  ApartmentOutlined,
  ApiOutlined,
  BarChartOutlined,
  CloudServerOutlined,
  ContactsOutlined,
  CustomerServiceOutlined,
  DatabaseOutlined,
  TeamOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import type { FeatureColor } from "@/lib/theme/colors";

/**
 * Every `@ant-design/icons` export shares one type, so borrowing it from a
 * single icon keeps the definitions honest without importing antd internals.
 */
export type ShellIcon = typeof DatabaseOutlined;

export interface PagePresentation {
  color: FeatureColor;
  icon: ShellIcon;
  /** Quick actions only: the second line of the row. */
  subtitle?: string;
}

/** Presentation per page key. A key missing here falls back to `DEFAULT_PRESENTATION`. */
export const PAGE_PRESENTATION: Readonly<Record<string, PagePresentation>> = {
  overview: { color: "overview", icon: BarChartOutlined },
  constants: { color: "constants", icon: DatabaseOutlined },
  user_management: { color: "users", icon: TeamOutlined },
  customers: { color: "users", icon: ContactsOutlined },
  support: { color: "support", icon: CustomerServiceOutlined },
  access_map: { color: "accessMap", icon: ApartmentOutlined },
  services: { color: "services", icon: CloudServerOutlined },
  integrations: { color: "integrations", icon: ApiOutlined },
  invite_user: { color: "users", icon: UserAddOutlined, subtitle: "Send an invitation to a new operator" },
  invite_customer: {
    color: "users",
    icon: UserAddOutlined,
    subtitle: "Create a consumer-app account and email the invitation",
  },
};

export const DEFAULT_PRESENTATION: PagePresentation = { color: "neutral", icon: DatabaseOutlined };

export function presentationFor(key: string): PagePresentation {
  return PAGE_PRESENTATION[key] ?? DEFAULT_PRESENTATION;
}

/* -------------------------------------------------------------------------- */
/*                         What the layout hands the shell                    */
/* -------------------------------------------------------------------------- */

/** A rail tab the caller may open, already filtered and ordered by the access map. */
export interface ShellTab {
  key: string;
  href: string;
  label: string;
}

/**
 * A page the caller may open from the nav bar's gear menu instead of the rail:
 * the same access-map decision as a tab, drawn somewhere else. The `section`
 * field in `src/lib/admin-access/page-registry.ts` is what sorts a page into
 * one list or the other.
 */
export interface ShellSettingsEntry {
  key: string;
  href: string;
  label: string;
  /** The row's second line, from the access map's description. */
  description: string;
}

/** A quick action the caller may use, already filtered and ordered by the access map. */
export interface ShellQuickAction {
  key: string;
  title: string;
  subtitle: string;
}

/** Identifies which entry drawer a quick action opens. Keys match `admin_pages`. */
export type QuickActionKind = "invite_user" | "invite_customer";

/** Width of the entry drawers, matching the consumer app's 600pt. */
export const ENTRY_DRAWER_WIDTH = 600;
