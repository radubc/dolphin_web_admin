"use client";

/**
 * Customers: the people using the consumer app, and the invitations that let
 * them in.
 *
 * Three views, one screen. A segmented control in the ribbon switches between
 * them and the choice is written into `?view=` with `history.replaceState`, so
 * a reload or a shared link lands on the same one without a server round trip.
 * Each view owns its own frame — its figures, its rail card and its ribbon all
 * describe what is actually on screen — and is mounted alone, so the
 * invitation log is not fetched while the customer table is being read, and
 * the Activity view's aggregates (which are the expensive read of the three)
 * are not run at all unless somebody asks for them.
 *
 * The invite drawer is owned here rather than by either view: it is reachable
 * from both ribbons and from the shell's "New" menu, and it must survive the
 * view being switched underneath it.
 */

import { useCallback, useState } from "react";
import { Segmented } from "antd";
import { AreaChartOutlined, ContactsOutlined, MailOutlined } from "@ant-design/icons";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import ActivityView from "./activity-view";
import CustomersView from "./customers-view";
import InviteCustomerDrawer from "./invite-customer-drawer";
import InvitesView from "./invites-view";
import type { CustomersViewKey } from "./views";

const VIEW_OPTIONS: ReadonlyArray<{ value: CustomersViewKey; label: string; icon: React.ReactNode }> = [
  { value: "customers", label: "Customers", icon: <ContactsOutlined /> },
  { value: "invites", label: "Invitations", icon: <MailOutlined /> },
  { value: "activity", label: "Activity", icon: <AreaChartOutlined /> },
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
  // "Take snapshot" on the Activity view starts a `cognito_directory` run
  // through the integrations endpoint, so the action that governs it is that
  // endpoint's — not one of the customer actions. Presentation only, as
  // above: the server checks it again.
  const canSnapshot = canDo(capabilities, "can_write_integrations");

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
      {view === "activity" ? (
        <ActivityView switcher={switcher} canSnapshot={canSnapshot} />
      ) : view === "invites" ? (
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
