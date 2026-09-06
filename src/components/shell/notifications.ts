/**
 * Shape of a shell notification and the placeholder set the shell starts with.
 *
 * The consumer apps keep this list in a singleton the
 * bell badge, the popover and the notification center all read. Here the shell
 * owns it in `useState` so those three stay in agreement; swap the initial
 * value for a fetch when the notifications API exists.
 */
import type { FeatureColor } from "@/lib/theme/colors";
import type { ShellIcon } from "./definitions";

export interface ShellNotification {
  id: string;
  title: string;
  body: string;
  /** Pre-formatted for now; a real one would carry a Date. */
  timestamp: string;
  read: boolean;
  icon: ShellIcon;
  color: FeatureColor;
}

/** How many rows the popover shows before it defers to "View All". */
export const POPOVER_VISIBLE_LIMIT = 6;

/**
 * What the shell starts with. Empty until the admin notifications API exists;
 * the badge, the popover and the centre all render their empty states.
 */
export const INITIAL_NOTIFICATIONS: ShellNotification[] = [];

export function unreadCountOf(notifications: readonly ShellNotification[]) {
  return notifications.reduce((total, item) => (item.read ? total : total + 1), 0);
}
