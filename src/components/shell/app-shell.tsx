"use client";

import { useCallback, useState, type ReactNode } from "react";
import { Drawer, Typography } from "antd";
import AccountSecurityDrawer from "@/components/account/account-security-drawer";
import { surfaceColors } from "@/lib/theme/colors";
import BottomTabBar from "./bottom-tab-bar";
import EntryDrawer from "./entry-drawer";
import NavBar from "./nav-bar";
import NotificationCenter from "./notification-center";
import SideRail from "./side-rail";
import type { AdminCapabilities } from "@/lib/admin-access/types";
import type {
  QuickActionKind,
  ShellQuickAction,
  ShellSettingsEntry,
  ShellTab,
} from "./definitions";
import { INITIAL_NOTIFICATIONS, type ShellNotification } from "./notifications";

interface AppShellProps {
  /** From the verified session, for the nav bar name and the user menu. */
  email: string | null;
  /** From the verified session's `given_name`/`name` claim, for the nav bar. */
  name: string | null;
  /** The operator's allowlist row and actions, for the quick-action forms. */
  capabilities: AdminCapabilities;
  /** Rail tabs the operator may open, in order, per the access map. */
  tabs: readonly ShellTab[];
  /** Gear-menu pages the operator may open, in order, per the access map. */
  settingsEntries: readonly ShellSettingsEntry[];
  /** Quick actions the operator may use, in order, per the access map. */
  quickActions: readonly ShellQuickAction[];
  /** The active page, rendered in the scrolling content area. */
  children: ReactNode;
}

/**
 * The authenticated frame: nav bar on top, tab rail on the left, page content
 * on the right, and every drawer and overlay mounted here so they sit above
 * the whole window — the same arrangement as the consumer web app's shell.
 *
 * Below `lg` the rail moves to the bottom of the column as a scrolling tab
 * bar and the nav bar sheds everything the avatar menu can carry instead; at
 * `lg` and above the frame is exactly what it has always been.
 *
 * Overlay state lives at this level rather than in the nav bar because a drawer
 * raised from a quick action has to survive the popover that opened it, and
 * because the notification list is read by the bell badge, the popover and the
 * centre at once.
 */
export default function AppShell({
  email,
  name,
  capabilities,
  tabs,
  settingsEntries,
  quickActions,
  children,
}: AppShellProps) {
  const [entryKind, setEntryKind] = useState<QuickActionKind | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // The operator's own Cognito settings, raised from the avatar menu.
  const [accountOpen, setAccountOpen] = useState(false);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  // Empty until the admin notifications API exists; see ./notifications.
  const [notifications, setNotifications] = useState<ShellNotification[]>(
    () => INITIAL_NOTIFICATIONS,
  );

  const setRead = useCallback((id: string, read: boolean) => {
    setNotifications((current) =>
      current.map((item) => (item.id === id ? { ...item, read } : item)),
    );
  }, []);

  const markRead = useCallback((id: string) => setRead(id, true), [setRead]);
  const markUnread = useCallback((id: string) => setRead(id, false), [setRead]);

  const markAllRead = useCallback(() => {
    setNotifications((current) =>
      current.map((item) => (item.read ? item : { ...item, read: true })),
    );
  }, []);

  const deleteNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  return (
    <div
      className="flex h-dvh min-h-0 flex-col"
      style={{ background: surfaceColors.page, color: surfaceColors.text }}
    >
      <NavBar
        email={email}
        name={name}
        notifications={notifications}
        quickActions={quickActions}
        settingsEntries={settingsEntries}
        onQuickAction={setEntryKind}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenAccount={() => setAccountOpen(true)}
        onOpenNotificationCenter={() => setNotificationCenterOpen(true)}
        onMarkNotificationRead={markRead}
        onMarkNotificationUnread={markUnread}
        onMarkAllNotificationsRead={markAllRead}
        onDeleteNotification={deleteNotification}
      />

      <div className="flex min-h-0 flex-1">
        <SideRail tabs={tabs} />
        {/* Only the content area scrolls; the bar and the rail stay put. A
            column, so a page can be a fixed-height one — a list page hands the
            leftover height to its table and scrolls the rows instead of the
            page — while `overflow-y-auto` still catches every page that is
            taller than the window: Overview, the stubs, a stack of cards. */}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </div>

      {/* The compact layout's navigation, hidden at `lg` and above. A row of
          the column rather than a fixed overlay, so it takes its height out of
          `<main>` instead of covering the bottom of the page. */}
      <BottomTabBar tabs={tabs} />

      {/* Learning Centre. Placeholder content, as in the consumer app. */}
      <Drawer
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        placement="right"
        size={420}
        title="Learning Centre"
      >
        <Typography.Paragraph type="secondary">
          Learning Centre…
        </Typography.Paragraph>
      </Drawer>

      <AccountSecurityDrawer
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        email={email}
      />

      <EntryDrawer
        kind={entryKind}
        capabilities={capabilities}
        onClose={() => setEntryKind(null)}
      />

      <NotificationCenter
        open={notificationCenterOpen}
        onClose={() => setNotificationCenterOpen(false)}
        notifications={notifications}
        onMarkRead={markRead}
        onMarkUnread={markUnread}
        onMarkAllRead={markAllRead}
        onDelete={deleteNotification}
      />
    </div>
  );
}
