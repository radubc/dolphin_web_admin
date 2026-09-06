"use client";

import { useState } from "react";
import { Empty, Modal, Segmented, Typography } from "antd";
import { surfaceColors } from "@/lib/theme/colors";
import NotificationRow from "./notification-row";
import { unreadCountOf, type ShellNotification } from "./notifications";

type Filter = "all" | "unread";

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  notifications: readonly ShellNotification[];
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onMarkAllRead: () => void;
  onDelete: (id: string) => void;
}

/**
 * The full list behind "View All". Same rows as the popover, no six-item cap,
 * plus an All/Unread filter. Reads the shell's notification state, so anything
 * marked here is reflected in the bell badge immediately.
 */
export default function NotificationCenter({
  open,
  onClose,
  notifications,
  onMarkRead,
  onMarkUnread,
  onMarkAllRead,
  onDelete,
}: NotificationCenterProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const unread = unreadCountOf(notifications);
  const visible =
    filter === "unread" ? notifications.filter((n) => !n.read) : notifications;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Notification Center"
      footer={null}
      width={640}
    >
      <div className="mb-3 flex items-center gap-3">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { label: "All", value: "all" },
            { label: `Unread${unread > 0 ? ` (${unread})` : ""}`, value: "unread" },
          ]}
        />
        {unread > 0 ? (
          <Typography.Link className="ms-auto" onClick={onMarkAllRead}>
            Mark all read
          </Typography.Link>
        ) : null}
      </div>

      <div
        className="max-h-[60vh] overflow-y-auto"
        style={{ border: `1px solid ${surfaceColors.separator}`, borderRadius: 8 }}
      >
        {visible.length === 0 ? (
          <div className="py-8">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Typography.Text type="secondary">
                  You&apos;re all caught up
                </Typography.Text>
              }
            />
          </div>
        ) : (
          visible.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onMarkRead={onMarkRead}
              onMarkUnread={onMarkUnread}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </Modal>
  );
}
