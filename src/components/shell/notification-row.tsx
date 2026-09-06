"use client";

import { Dropdown } from "antd";
import { CheckOutlined, DeleteOutlined, MailOutlined } from "@ant-design/icons";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import type { ShellNotification } from "./notifications";

export interface NotificationRowProps {
  notification: ShellNotification;
  /** Tapping a row is an acknowledgement; unread only comes back from the menu. */
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * One notification. Unread rows carry a faint blue tint (mixed from the banking
 * accent so no new colour enters the palette) and the right-click menu offers
 * the read/unread flip and delete, as in the native popover.
 */
export default function NotificationRow({
  notification,
  onMarkRead,
  onMarkUnread,
  onDelete,
}: NotificationRowProps) {
  const { icon: Icon } = notification;

  return (
    <Dropdown
      trigger={["contextMenu"]}
      menu={{
        items: [
          notification.read
            ? {
                key: "unread",
                label: "Mark as Unread",
                icon: <MailOutlined />,
                onClick: () => onMarkUnread(notification.id),
              }
            : {
                key: "read",
                label: "Mark as Read",
                icon: <CheckOutlined />,
                onClick: () => onMarkRead(notification.id),
              },
          { type: "divider" as const },
          {
            key: "delete",
            label: "Delete",
            icon: <DeleteOutlined />,
            danger: true,
            onClick: () => onDelete(notification.id),
          },
        ],
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (!notification.read) onMarkRead(notification.id);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!notification.read) onMarkRead(notification.id);
          }
        }}
        className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 transition-colors hover:bg-black/[0.03]"
        style={{
          borderBottom: `1px solid ${surfaceColors.separator}`,
          background: notification.read
            ? undefined
            : `color-mix(in srgb, ${featureColors.banking} 7%, transparent)`,
        }}
      >
        <Icon
          style={{
            fontSize: 16,
            marginTop: 2,
            color: featureColors[notification.color],
            flexShrink: 0,
          }}
        />
        <div className="flex min-w-0 flex-col">
          <span
            className="text-sm"
            style={{
              color: surfaceColors.text,
              fontWeight: notification.read ? 500 : 600,
            }}
          >
            {notification.title}
          </span>
          <span
            className="text-xs"
            style={{ color: surfaceColors.textSecondary }}
          >
            {notification.body}
          </span>
          <span
            className="mt-0.5 text-[11px]"
            style={{ color: surfaceColors.textTertiary }}
          >
            {notification.timestamp}
          </span>
        </div>
      </div>
    </Dropdown>
  );
}
