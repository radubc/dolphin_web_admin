"use client";

/**
 * "Account & security": everything an operator can change about their **own**
 * sign-in — password, authenticator app, passkeys.
 *
 * A drawer raised from the avatar menu, not a page, and deliberately so:
 *
 * - it is self-service, not an admin capability. A page would need a
 *   `page-registry.ts` entry and an Access Map rule, and every operator would
 *   have to be granted the right to reach their own password;
 * - the shell already mounts its drawers above the whole window
 *   (`app-shell.tsx`), so it opens over whatever page is on screen and closes
 *   without losing it;
 * - the "Account" item was already in the avatar menu with nowhere to go.
 *
 * The endpoints behind it are registered like any other (`admin.me.*`, all
 * "any enabled operator"), because every write still goes through
 * `adminHandler` and is counted on the Services page.
 *
 * The three sections load nothing until the drawer is opened: `destroyOnHidden`
 * unmounts them on close, so each open reads the live state from Cognito
 * rather than showing what was true the last time.
 */

import { Drawer, Typography } from "antd";
import {
  KeyOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import FormSection from "@/components/form-section";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { featureColors } from "@/lib/theme/colors";
import ChangePasswordForm from "./change-password-form";
import PasskeysSection from "./passkeys-section";
import TwoFactorSection from "./two-factor-section";

interface AccountSecurityDrawerProps {
  open: boolean;
  onClose: () => void;
  /** From the verified session; null when the id token carried no email. */
  email: string | null;
}

export default function AccountSecurityDrawer({
  open,
  onClose,
  email,
}: AccountSecurityDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      title="Account & security"
      destroyOnHidden
    >
      <div className="flex flex-col gap-4">
        <Typography.Text type="secondary">
          {email
            ? `Signed in as ${email}. These settings live in the admin Cognito user pool and affect only your own account.`
            : "These settings live in the admin Cognito user pool and affect only your own account."}
        </Typography.Text>

        <FormSection
          title="Password"
          icon={<LockOutlined />}
          color={featureColors.users}
        >
          <ChangePasswordForm />
        </FormSection>

        <FormSection
          title="Two-factor authentication"
          icon={<SafetyCertificateOutlined />}
          color={featureColors.accessMap}
        >
          <TwoFactorSection />
        </FormSection>

        <FormSection
          title="Passkeys"
          icon={<KeyOutlined />}
          color={featureColors.services}
        >
          <PasskeysSection />
        </FormSection>
      </div>
    </Drawer>
  );
}
