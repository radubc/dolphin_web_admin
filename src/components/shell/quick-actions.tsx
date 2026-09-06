"use client";

import { AccentHeading } from "@/components/page-header";
import ActionRow from "./action-row";
import { quickActions, type QuickActionKind } from "./definitions";

interface QuickActionsProps {
  /** Closes the popover and opens the matching entry drawer. */
  onSelect: (kind: QuickActionKind) => void;
}

/** Body of the "New" popover: the entry points into the app. */
export default function QuickActions({ onSelect }: QuickActionsProps) {
  return (
    <div className="flex w-[320px] flex-col gap-0.5">
      <AccentHeading className="mb-2 px-2.5">Quick Actions</AccentHeading>
      {quickActions.map((action) => (
        <ActionRow
          key={action.kind}
          icon={action.icon}
          title={action.title}
          subtitle={action.subtitle}
          color={action.color}
          onClick={() => onSelect(action.kind)}
        />
      ))}
    </div>
  );
}
