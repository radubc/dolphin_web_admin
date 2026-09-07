"use client";

import { useEffect, useState } from "react";
import { App } from "antd";
import InviteCustomerDrawer from "@/components/customers/invite-customer-drawer";
import UserFormDrawer from "@/components/user-management/user-form-drawer";
import { adminAccessApi } from "@/lib/admin-access/client";
import type { AdminCapabilities, AdminRole } from "@/lib/admin-access/types";
import type { QuickActionKind } from "./definitions";

interface EntryDrawerProps {
  /** Which quick action is being entered, or null when the drawer is closed. */
  kind: QuickActionKind | null;
  capabilities: AdminCapabilities;
  onClose: () => void;
}

/**
 * The quick-action entry drawers, driven by `kind`.
 *
 * As in the consumer app, every kind renders the same form its own page uses,
 * in add mode, and stays mounted with its own `open` so it can play its
 * slide-out. Two kinds so far:
 *
 * - "Invite user" mounts the User Management page's form. It loads the role
 *   catalog itself when it opens — the shell has no store — and announces the
 *   new user through the API client so the page refreshes if it is on screen.
 * - "Invite customer" mounts the Customers page's invite drawer, which is
 *   already self-contained: it owns its own toast and announces the new
 *   invitation, so there is nothing for the shell to wire up.
 */
export default function EntryDrawer({ kind, capabilities, onClose }: EntryDrawerProps) {
  return (
    <>
      <InviteUserEntryDrawer
        open={kind === "invite_user"}
        capabilities={capabilities}
        onClose={onClose}
      />
      <InviteCustomerDrawer open={kind === "invite_customer"} onClose={onClose} />
    </>
  );
}

function InviteUserEntryDrawer({
  open,
  capabilities,
  onClose,
}: {
  open: boolean;
  capabilities: AdminCapabilities;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [roles, setRoles] = useState<AdminRole[]>([]);

  // Only a super-admin may invite, and only they may list roles, so the fetch
  // is skipped for anyone else; the form then opens read-only with no roles.
  useEffect(() => {
    if (!open || !capabilities.isSuperAdmin) return;
    let cancelled = false;
    void adminAccessApi
      .listRoles()
      .then((list) => {
        if (!cancelled) setRoles(list);
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, capabilities.isSuperAdmin]);

  return (
    <UserFormDrawer
      open={open}
      user={null}
      roles={roles}
      capabilities={capabilities}
      onClose={onClose}
      onCreate={async (input) => {
        const user = await adminAccessApi.createUser(input);
        message.success(`Invitation recorded for ${user.email}.`);
        return user;
      }}
      onUpdate={async () => undefined}
    />
  );
}
