"use client";

import { useState } from "react";
import Image from "next/image";
import { Badge, Button, Popover } from "antd";
import {
  BellOutlined,
  PlusCircleFilled,
  QuestionCircleOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { surfaceColors } from "@/lib/theme/colors";
import NotificationsPopover from "./notifications-popover";
import QuickActions from "./quick-actions";
import SettingsPopover from "./settings-popover";
import UserMenu from "./user-menu";
import type { QuickActionKind, ShellQuickAction, ShellSettingsEntry } from "./definitions";
import { unreadCountOf, type ShellNotification } from "./notifications";

/** Nav bar height, matching the consumer app's 60pt toolbar. */
export const NAV_BAR_HEIGHT = 60;

/** Shared look of the toolbar icon buttons. */
const TOOLBAR_ICON_STYLE = {
  fontSize: 18,
  color: surfaceColors.textSecondary,
} as const;

/**
 * The symbol logo's rendered box. The file is 1092 × 1050, so declaring the
 * display size keeps `next/image` from serving the full-resolution asset for a
 * 36px-tall mark.
 */
const LOGO_HEIGHT = 36;
const LOGO_WIDTH = 37;

interface NavBarProps {
  email: string | null;
  name: string | null;
  notifications: readonly ShellNotification[];
  quickActions: readonly ShellQuickAction[];
  /** Pages the operator may open from the gear menu, per the access map. */
  settingsEntries: readonly ShellSettingsEntry[];
  onQuickAction: (kind: QuickActionKind) => void;
  onOpenHelp: () => void;
  onOpenAccount: () => void;
  onOpenNotificationCenter: () => void;
  onMarkNotificationRead: (id: string) => void;
  onMarkNotificationUnread: (id: string) => void;
  onMarkAllNotificationsRead: () => void;
  onDeleteNotification: (id: string) => void;
}

/**
 * Derive a display name from the session: the `given_name`/`name` claim
 * (already resolved into `name` by `verifyIdToken()`) when there is one,
 * else the email's local part, else "Account".
 */
function displayNameFor(name: string | null, email: string | null): string {
  if (name) return name;
  if (!email) return "Account";
  const localPart = email.split("@")[0];
  return localPart.length > 0 ? localPart : "Account";
}

/**
 * The top bar: brand and user on the left, the "New" quick-action button in the
 * middle, help / notifications / account on the right.
 *
 * Same chrome as the consumer web app's bar — a white surface with a hairline
 * under it — minus the global search, which has nothing to search in the admin
 * console yet; it slots back in beside the bell when it does. The gear beside
 * the bell lists the pages the build files under Settings (User Management,
 * Customers) rather than on the rail, filtered by the access map like every
 * other entry.
 *
 * The popovers are owned here because they hang off these buttons; anything
 * they *open* — drawers, the notification centre — is shell state and is raised
 * through the callbacks above.
 *
 * On compact the bar keeps the brand, "New", the bell and the avatar, and
 * gives up the display name, Help and the gear — the last two reappear inside
 * the avatar menu, so nothing becomes unreachable.
 */
export default function NavBar({
  email,
  name,
  notifications,
  quickActions,
  settingsEntries,
  onQuickAction,
  onOpenHelp,
  onOpenAccount,
  onOpenNotificationCenter,
  onMarkNotificationRead,
  onMarkNotificationUnread,
  onMarkAllNotificationsRead,
  onDeleteNotification,
}: NavBarProps) {
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const unread = unreadCountOf(notifications);

  return (
    <header
      // Compact keeps the same bar, tightened: `max-lg:` only ever applies
      // below `lg`, so the desktop bar is untouched.
      className="flex shrink-0 items-center gap-5 px-5 max-lg:gap-3 max-lg:px-4"
      style={{
        height: NAV_BAR_HEIGHT,
        background: surfaceColors.card,
        borderBottom: `1px solid ${surfaceColors.separator}`,
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        {/* The symbol alone: the wordmark would repeat the name beside it. */}
        <Image
          src="/brand/symbol.png"
          alt="Penny Squeeze Admin"
          width={LOGO_WIDTH}
          height={LOGO_HEIGHT}
          sizes="40px"
          priority
          style={{ height: LOGO_HEIGHT, width: "auto" }}
        />
        {/* Hidden on compact: the avatar menu already names the account, and
            the bar needs the width for "New" and the bell. */}
        <span
          className="truncate text-base font-semibold max-lg:hidden"
          style={{ color: surfaceColors.text }}
        >
          {displayNameFor(name, email)}
        </span>
      </div>

      <div className="flex flex-1 justify-center">
        <Popover
          open={quickActionsOpen}
          onOpenChange={setQuickActionsOpen}
          trigger="click"
          placement="bottom"
          content={
            <QuickActions
              actions={quickActions}
              onSelect={(kind) => {
                setQuickActionsOpen(false);
                onQuickAction(kind);
              }}
            />
          }
        >
          {/* The one filled control in the bar: the primary action stays the
              primary action. */}
          <Button
            type="primary"
            shape="round"
            icon={<PlusCircleFilled />}
            style={{ fontWeight: 600 }}
          >
            New
          </Button>
        </Popover>
      </div>

      <div className="flex items-center gap-5 max-lg:gap-3">
        {/* Help and Settings fold into the avatar menu on compact; the bell
            and the avatar stay in the bar.

            The `max-lg:hidden` sits on a plain wrapper rather than on the
            antd control itself: antd injects its CSS unlayered, so its
            `.ant-btn { display: inline-flex }` outranks a Tailwind utility in
            `@layer utilities` no matter how specific the selector is. The
            wrapper is `inline-flex` for the same reason the bell's is —
            a block box would open a line box under the button. */}
        <span className="inline-flex max-lg:hidden">
          <Button
            type="text"
            shape="circle"
            title="Help"
            aria-label="Help"
            icon={<QuestionCircleOutlined style={TOOLBAR_ICON_STYLE} />}
            onClick={onOpenHelp}
          />
        </span>

        <Popover
          open={notificationsOpen}
          onOpenChange={setNotificationsOpen}
          trigger="click"
          placement="bottomRight"
          content={
            <NotificationsPopover
              notifications={notifications}
              onMarkRead={onMarkNotificationRead}
              onMarkUnread={onMarkNotificationUnread}
              onMarkAllRead={onMarkAllNotificationsRead}
              onDelete={onDeleteNotification}
              onViewAll={() => {
                setNotificationsOpen(false);
                onOpenNotificationCenter();
              }}
            />
          }
        >
          {/* The badge, not the button, is the popover's trigger element: the
              click bubbles up from the button inside it. */}
          <span className="inline-flex">
            <Badge
              count={unread}
              overflowCount={99}
              size="small"
              offset={[-2, 2]}
            >
              <Button
                type="text"
                shape="circle"
                title="Notifications"
                aria-label={
                  unread > 0
                    ? `Notifications, ${unread} unread`
                    : "Notifications"
                }
                icon={<BellOutlined style={TOOLBAR_ICON_STYLE} />}
              />
            </Badge>
          </span>
        </Popover>

        {/* Wrapped, not classed, for the cascade reason above; the Button
            stays the popover's trigger. */}
        <span className="inline-flex max-lg:hidden">
          <Popover
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            trigger="click"
            placement="bottomRight"
            content={
              <SettingsPopover
                entries={settingsEntries}
                onSelect={() => setSettingsOpen(false)}
              />
            }
          >
            <Button
              type="text"
              shape="circle"
              title="Settings"
              aria-label="Settings"
              icon={<SettingOutlined style={TOOLBAR_ICON_STYLE} />}
            />
          </Popover>
        </span>

        {/* The menu grows a Help item and the settings pages on compact, where
            the two buttons above are hidden; on desktop it is unchanged. */}
        <UserMenu
          email={email}
          settingsEntries={settingsEntries}
          onOpenAccount={onOpenAccount}
          onOpenHelp={onOpenHelp}
        />
      </div>
    </header>
  );
}
