"use client";

import { Typography } from "antd";
import { AccentHeading } from "@/components/page-header";
import ActionRow from "./action-row";
import { presentationFor, type QuickActionKind, type ShellQuickAction } from "./definitions";

interface QuickActionsProps {
  actions: readonly ShellQuickAction[];
  /** Closes the popover and opens the matching entry drawer. */
  onSelect: (kind: QuickActionKind) => void;
}

/**
 * Body of the "New" popover: the entry points the caller may use, filtered by
 * the access map before they reach here.
 */
export default function QuickActions({ actions, onSelect }: QuickActionsProps) {
  // The cap keeps the card inside a 375px phone with the popover's own
  // margin to spare; on anything wider it is the 320px it always was.
  return (
    <div className="flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-0.5">
      <AccentHeading className="mb-2 px-2.5">Quick Actions</AccentHeading>
      {actions.length === 0 ? (
        <Typography.Text type="secondary" className="px-2.5 py-2 text-sm">
          Nothing you can add from here yet.
        </Typography.Text>
      ) : (
        actions.map((action) => {
          const presentation = presentationFor(action.key);
          return (
            <ActionRow
              key={action.key}
              icon={presentation.icon}
              title={action.title}
              subtitle={action.subtitle}
              color={presentation.color}
              onClick={() => onSelect(action.key as QuickActionKind)}
            />
          );
        })
      )}
    </div>
  );
}
