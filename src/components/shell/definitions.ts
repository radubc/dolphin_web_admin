/**
 * Static description of the admin shell: the tabs on the side rail and the
 * quick actions behind the "New" button. Same shape as the consumer web app's
 * `definitions.ts`, so the shell components are shared code with a different
 * list behind them.
 *
 * Data only, no JSX, so the shell's client components can share it without any
 * of them owning the list. Icons are stored as components and rendered by the
 * consumer, which is also what lets this stay a `.ts` file.
 */
import {
  BarChartOutlined,
  CustomerServiceOutlined,
  DatabaseOutlined,
  TeamOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import type { FeatureColor } from "@/lib/theme/colors";
import { TAB_ROUTES } from "./routes";

/**
 * Every `@ant-design/icons` export shares one type, so borrowing it from a
 * single icon keeps the definitions honest without importing antd internals.
 */
export type ShellIcon = typeof DatabaseOutlined;

/* -------------------------------------------------------------------------- */
/*                                    Tabs                                    */
/* -------------------------------------------------------------------------- */

export interface TabDefinition {
  /** Route the rail links to. The tab is active when the pathname matches. */
  href: string;
  /** Two-line label under the icon. */
  label: string;
  /**
   * The domain's feature colour. The rail marks the active tab in the accent
   * blue instead, but each tab keeps its colour here for the pages, cards and
   * empty states that colour themselves by domain.
   */
  color: FeatureColor;
  icon: ShellIcon;
}

/** The tabs on the rail, top to bottom. Overview is first and the landing page. */
export const primaryTabs: readonly TabDefinition[] = [
  {
    href: TAB_ROUTES.overview,
    label: "Overview",
    color: "overview",
    icon: BarChartOutlined,
  },
  {
    href: TAB_ROUTES.constants,
    label: "Constants",
    color: "constants",
    icon: DatabaseOutlined,
  },
  {
    href: TAB_ROUTES.userManagement,
    label: "User Management",
    color: "users",
    icon: TeamOutlined,
  },
  {
    href: TAB_ROUTES.support,
    label: "Support",
    color: "support",
    icon: CustomerServiceOutlined,
  },
] as const;

/** Every tab, rail order, for anything that needs the flat list. */
export const allTabs: readonly TabDefinition[] = primaryTabs;

/* -------------------------------------------------------------------------- */
/*                                Quick actions                               */
/* -------------------------------------------------------------------------- */

/** Identifies which entry drawer a quick action opens. */
export type QuickActionKind = "inviteUser";

export interface QuickActionDefinition {
  kind: QuickActionKind;
  title: string;
  subtitle: string;
  color: FeatureColor;
  icon: ShellIcon;
}

/** The rows in the "New" popover. One for now. */
export const quickActions: readonly QuickActionDefinition[] = [
  {
    kind: "inviteUser",
    title: "Invite user",
    subtitle: "Send an invitation to a new operator",
    color: "users",
    icon: UserAddOutlined,
  },
] as const;

/** Lookup used by the entry drawer to title itself from the `kind` alone. */
export function quickActionFor(
  kind: QuickActionKind,
): QuickActionDefinition | undefined {
  return quickActions.find((action) => action.kind === kind);
}

/** Width of the entry drawers, matching the consumer app's 600pt. */
export const ENTRY_DRAWER_WIDTH = 600;
