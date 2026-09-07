"use client";

import { Typography } from "antd";
import { AccentHeading } from "@/components/page-header";
import ActionRow from "./action-row";
import { presentationFor, type ShellSettingsEntry } from "./definitions";

interface SettingsPopoverProps {
  entries: readonly ShellSettingsEntry[];
  /** Closes the popover; the row itself is a link and does the navigating. */
  onSelect: () => void;
}

/**
 * Body of the gear popover: the pages this operator may open that the build
 * files under Settings rather than on the rail.
 *
 * Same rows as the "New" popover, for the same reason the native app draws
 * `SettingsButton` and `QuickActionButton` with one control — but these
 * navigate instead of opening a drawer, so `ActionRow` is given an `href`.
 *
 * The list is already filtered: the layout resolved it from the access map,
 * exactly as it resolves the rail. An empty menu is possible and says so
 * rather than opening a blank card.
 */
export default function SettingsPopover({ entries, onSelect }: SettingsPopoverProps) {
  return (
    <div className="flex w-[320px] flex-col gap-0.5">
      <AccentHeading className="mb-2 px-2.5">Settings</AccentHeading>
      {entries.length === 0 ? (
        <Typography.Text type="secondary" className="px-2.5 py-2 text-sm">
          Nothing you can configure from here yet.
        </Typography.Text>
      ) : (
        entries.map((entry) => {
          const presentation = presentationFor(entry.key);
          return (
            <ActionRow
              key={entry.key}
              icon={presentation.icon}
              title={entry.label}
              subtitle={entry.description}
              color={presentation.color}
              href={entry.href}
              onClick={onSelect}
            />
          );
        })
      )}
    </div>
  );
}
