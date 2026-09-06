"use client";

import { useState } from "react";
import Image from "next/image";
import { Badge, Button, Popover } from "antd";
import {
  BellOutlined,
  PlusCircleFilled,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import { surfaceColors } from "@/lib/theme/colors";
import NotificationsPopover from "./notifications-popover";
import QuickActions from "./quick-actions";
import UserMenu from "./user-menu";
import type { QuickActionKind, ShellQuickAction } from "./definitions";
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
  onQuickAction: (kind: QuickActionKind) => void;
  onOpenHelp: () => void;
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
 * under it — minus the global search and the settings gear, which have nothing
 * to search or configure in the admin console yet. Both slot back in beside the
 * bell when they do.
 *
 * The popovers are owned here because they hang off these buttons; anything
 * they *open* — drawers, the notification centre — is shell state and is raised
 * through the callbacks above.
 */
export default function NavBar({
  email,
  name,
  notifications,
  quickActions,
  onQuickAction,
  onOpenHelp,
  onOpenNotificationCenter,
  onMarkNotificationRead,
  onMarkNotificationUnread,
  onMarkAllNotificationsRead,
  onDeleteNotification,
}: NavBarProps) {
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const unread = unreadCountOf(notifications);

  return (
    <header
      className="flex shrink-0 items-center gap-5 px-5"
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
        <span
          className="truncate text-base font-semibold"
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

      <div className="flex items-center gap-5">
        <Button
          type="text"
          shape="circle"
          title="Help"
          aria-label="Help"
          icon={<QuestionCircleOutlined style={TOOLBAR_ICON_STYLE} />}
          onClick={onOpenHelp}
        />

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

        <UserMenu email={email} />
      </div>
    </header>
  );
}
