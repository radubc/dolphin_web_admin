"use client";

/**
 * Customers: the people using the consumer app, and the invitations that let
 * them in.
 *
 * Two views, one screen. A segmented control in the ribbon switches between
 * them and the choice is written into `?view=` with `history.replaceState`, so
 * a reload or a shared link lands on the same one without a server round trip.
 * Each view owns its own frame — its figures, its rail card and its ribbon all
 * describe what is actually on screen — and is mounted alone, so the
 * invitation log is not fetched while the customer table is being read.
 *
 * The invite drawer is owned here rather than by either view: it is reachable
 * from both ribbons and from the shell's "New" menu, and it must survive the
 * view being switched underneath it.
 */

import { useCallback, useState } from "react";
import { Segmented } from "antd";
import { ContactsOutlined, MailOutlined } from "@ant-design/icons";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import CustomersView from "./customers-view";
import InviteCustomerDrawer from "./invite-customer-drawer";
import InvitesView from "./invites-view";
import type { CustomersViewKey } from "./views";

const VIEW_OPTIONS: ReadonlyArray<{ value: CustomersViewKey; label: string; icon: React.ReactNode }> = [
  { value: "customers", label: "Customers", icon: <ContactsOutlined /> },
  { value: "invites", label: "Invitations", icon: <MailOutlined /> },
];

interface CustomersPageProps {
  /** The signed-in operator, resolved on the server. */
  capabilities: AdminCapabilities;
  /** From `?view=`, so a link opens on the view it names. */
  initialView?: CustomersViewKey;
}

export default function CustomersPage({ capabilities, initialView }: CustomersPageProps) {
  const [view, setView] = useState<CustomersViewKey>(initialView ?? "customers");
  const [inviting, setInviting] = useState(false);
  // Whichever view is on screen reports its own `canSend`/`unavailableReason`
  // here, so the drawer this page owns knows before the operator opens it.
  const [sendability, setSendability] = useState<{ canSend: boolean; unavailableReason: string | null }>({
    canSend: true,
    unavailableReason: null,
  });

  // Presentation only: the server re-checks the action on every invite call.
  const canInvite = canDo(capabilities, "can_invite_users");

  const changeView = useCallback((next: CustomersViewKey) => {
    setView(next);
    // Shallow: the URL keeps up with the screen without re-running the Server
    // Component, which would only re-check the same page access.
    window.history.replaceState(null, "", `?view=${encodeURIComponent(next)}`);
  }, []);

  const switcher = (
    <span role="group" aria-label="Customers view" className="inline-block min-w-max">
      <Segmented<CustomersViewKey>
        value={view}
        onChange={changeView}
        options={[...VIEW_OPTIONS]}
      />
    </span>
  );

  const openInvite = useCallback(() => setInviting(true), []);

  const onSendabilityChange = useCallback(
    (canSend: boolean, unavailableReason: string | null) => setSendability({ canSend, unavailableReason }),
    [],
  );

  return (
    <>
      {view === "invites" ? (
        <InvitesView
          canInvite={canInvite}
          onInvite={openInvite}
          switcher={switcher}
          onSendabilityChange={onSendabilityChange}
        />
      ) : (
        <CustomersView
          canInvite={canInvite}
          onInvite={openInvite}
          switcher={switcher}
          onSendabilityChange={onSendabilityChange}
        />
      )}

      <InviteCustomerDrawer
        open={inviting}
        onClose={() => setInviting(false)}
        canSend={sendability.canSend}
        unavailableReason={sendability.unavailableReason}
      />
    </>
  );
}
