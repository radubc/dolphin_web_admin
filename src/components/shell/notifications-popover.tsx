"use client";

import { Button, Typography } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { surfaceColors } from "@/lib/theme/colors";
import NotificationRow from "./notification-row";
import {
  POPOVER_VISIBLE_LIMIT,
  unreadCountOf,
  type ShellNotification,
} from "./notifications";

/** Popover width, matching the native notification popover's 380pt. */
const POPOVER_WIDTH = 380;

interface NotificationsPopoverProps {
  notifications: readonly ShellNotification[];
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onMarkAllRead: () => void;
  onDelete: (id: string) => void;
  /** Closes the popover and opens the notification center. */
  onViewAll: () => void;
}

/**
 * The compact list hung off the bell: the six most recent notifications, a way
 * to clear the unread count, and a door through to the full center.
 */
export default function NotificationsPopover({
  notifications,
  onMarkRead,
  onMarkUnread,
  onMarkAllRead,
  onDelete,
  onViewAll,
}: NotificationsPopoverProps) {
  const unread = unreadCountOf(notifications);
  const recent = notifications.slice(0, POPOVER_VISIBLE_LIMIT);

  return (
    <div className="flex flex-col" style={{ width: POPOVER_WIDTH }}>
      <div
        className="flex items-center gap-2 px-3.5 pb-2"
        style={{ borderBottom: `1px solid ${surfaceColors.separator}` }}
      >
        <div className="flex flex-col">
          <span
            className="text-sm font-semibold"
            style={{ color: surfaceColors.text }}
          >
            Notifications
          </span>
          <span
            className="text-xs"
            style={{ color: surfaceColors.textSecondary }}
          >
            {unread > 0 ? `${unread} unread` : "No unread notifications"}
          </span>
        </div>
        {unread > 0 ? (
          <Button
            type="link"
            size="small"
            className="ms-auto"
            onClick={onMarkAllRead}
          >
            Mark all read
          </Button>
        ) : null}
      </div>

      {recent.length === 0 ? (
        <div className="flex flex-col items-center gap-2.5 px-4 py-9">
          {/* The native empty state is a bell-slash; antd has no crossed bell,
              so the bell is dimmed to tertiary instead. */}
          <BellOutlined
            style={{ fontSize: 28, color: surfaceColors.textTertiary }}
          />
          <Typography.Text type="secondary">
            You&apos;re all caught up
          </Typography.Text>
        </div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto">
          {recent.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onMarkRead={onMarkRead}
              onMarkUnread={onMarkUnread}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      <div
        className="pt-1"
        style={{ borderTop: `1px solid ${surfaceColors.separator}` }}
      >
        <Button type="link" block onClick={onViewAll}>
          View All
        </Button>
      </div>
    </div>
  );
}
