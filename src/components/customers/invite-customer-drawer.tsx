"use client";

/**
 * Invite a person to the consumer app.
 *
 * There is no self-service sign-up, so this is the only way a customer account
 * comes into being: the server calls `AdminCreateUser` on the customer pool,
 * Cognito emails a temporary password, and the person signs in and sets their
 * own. The address is the only field that matters to Cognito; name and locale
 * are optional here because the pool requires both but will ask the person for
 * whichever one is left blank at their first sign-in, and the note is for the
 * operator's own record. Everything else about the account is the person's to
 * fill in later.
 *
 * The two refusals worth naming are surfaced as they arrive rather than
 * flattened into "could not save": 409 when the address already has an account
 * or a live invitation, and 503 `cognito_unavailable` when this deployment
 * cannot reach the pool at all. Both come back from `apiFetch` as an
 * `ApiClientError` carrying the server's sentence.
 *
 * Mounted twice: from the Customers page's ribbon, and from the shell's "New"
 * menu through `entry-drawer.tsx`. It is self-contained for that reason — it
 * owns its own toast and announces the new invitation itself.
 *
 * The Customers page already knows whether sending is possible (it reads a
 * list) and passes `canSend`/`unavailableReason` down. The shell's quick
 * action has no list loaded, so when those props are left unset the drawer
 * fetches one page of invitations itself, on open, just to read `canSend` off
 * the response — cheap, and it means the warning shows before Send everywhere
 * this drawer opens. A failure there stays silent: the submit path already
 * surfaces the 503 if sending itself fails.
 */

import { useEffect, useState } from "react";
import { Alert, App, Button, Drawer, Form, Input, Select, Space, Typography } from "antd";
import { MailOutlined, UserAddOutlined } from "@ant-design/icons";
import FormSection from "@/components/form-section";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { customersApi } from "@/lib/customers/client";
import { errorMessage, trimToNull } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { CUSTOMERS_COLOR } from "./customers-meta";

/** Save lives in the footer, outside the form, and submits by association. */
const FORM_NAME = "invite-customer-form";

/** What the note column holds; longer than this is a document, not a note. */
const NOTE_MAX = 500;

/** What the pool's `name` attribute holds; matches the schema's cap. */
const NAME_MAX = 256;

/** Locales the pool has copy for. The default matches the pool's own. */
const LOCALE_OPTIONS = [
  { value: "en-CA", label: "English (Canada)" },
  { value: "fr-CA", label: "Français (Canada)" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "fr-FR", label: "Français (France)" },
  { value: "es-ES", label: "Español" },
  { value: "de-DE", label: "Deutsch" },
];

interface InviteFormValues {
  email: string;
  name: string;
  locale: string | null;
  note: string;
}

export interface InviteCustomerDrawerProps {
  open: boolean;
  onClose: () => void;
  /**
   * Whether the deployment can reach the pool at all; false disables the send.
   * Left unset when no caller has a list loaded to read it from (the shell's
   * quick action): the drawer then fetches one page itself to find out.
   */
  canSend?: boolean;
  /** The one-line reason shown when `canSend` is false. */
  unavailableReason?: string | null;
}

export default function InviteCustomerDrawer({
  open,
  onClose,
  canSend: canSendProp,
  unavailableReason: unavailableReasonProp = null,
}: InviteCustomerDrawerProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<InviteFormValues>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only used when the caller has not told us; a caller with a live list
  // (the Customers page) always wins.
  const [fetchedCanSend, setFetchedCanSend] = useState<{
    canSend: boolean;
    unavailableReason: string | null;
  } | null>(null);

  useEffect(() => {
    if (!open || canSendProp !== undefined) return;
    let cancelled = false;
    void customersApi.invites
      .list({ pageSize: 1 })
      .then((response) => {
        if (!cancelled) {
          setFetchedCanSend({ canSend: response.canSend, unavailableReason: response.unavailableReason });
        }
      })
      .catch(() => {
        // Silent: the submit path still surfaces the 503 if sending fails.
      });
    return () => {
      cancelled = true;
    };
  }, [open, canSendProp]);

  const canSend = canSendProp ?? fetchedCanSend?.canSend ?? true;
  const unavailableReason =
    canSendProp !== undefined ? unavailableReasonProp : (fetchedCanSend?.unavailableReason ?? null);

  const handleSubmit = async (values: InviteFormValues) => {
    setError(null);
    // Cognito treats the username case-sensitively, so the address is settled
    // here rather than leaving two spellings of one person in the log.
    const email = values.email.trim().toLowerCase();
    setSaving(true);
    try {
      const invite = await customersApi.invites.create({
        email,
        note: trimToNull(values.note),
        name: trimToNull(values.name),
        locale: values.locale,
      });
      message.success(`Invitation sent to ${invite.email}`);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      afterOpenChange={(opened) => {
        if (!opened) {
          form.resetFields();
          setError(null);
          setFetchedCanSend(null);
        }
      }}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          <UserAddOutlined style={{ fontSize: 18, color: CUSTOMERS_COLOR }} />
          <span>Invite customer</span>
        </span>
      }
      styles={{ body: { background: surfaceColors.page } }}
      footer={
        <div className="flex items-center justify-end">
          <Space>
            <Button onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              form={FORM_NAME}
              loading={saving}
              disabled={!canSend}
            >
              Send invitation
            </Button>
          </Space>
        </div>
      }
    >
      <Form<InviteFormValues>
        form={form}
        name={FORM_NAME}
        layout="vertical"
        disabled={saving || !canSend}
        requiredMark="optional"
        initialValues={{ email: "", name: "", locale: "en-US", note: "" }}
        onFinish={(values) => {
          void handleSubmit(values);
        }}
        onFinishFailed={() =>
          setError("Some fields need attention. Check the highlighted ones and try again.")
        }
        className="flex flex-col gap-4"
      >
        {!canSend && (
          <Alert
            type="warning"
            showIcon
            title="Invitations cannot be sent from this deployment."
            description={unavailableReason ?? undefined}
          />
        )}

        {error !== null && (
          <Alert type="error" showIcon title={error} closable={{ onClose: () => setError(null) }} />
        )}

        <FormSection title="Who to invite" icon={<MailOutlined />} color={CUSTOMERS_COLOR}>
          <Form.Item
            name="email"
            label="Email"
            tooltip="Cognito sends the temporary password here, and this becomes their sign-in name."
            rules={[
              { required: true, whitespace: true, message: "An email address is required" },
              { type: "email", message: "That does not look like an email address" },
            ]}
          >
            <Input
              type="email"
              autoComplete="off"
              inputMode="email"
              placeholder="person@example.com"
            />
          </Form.Item>

          <Form.Item
            name="name"
            label="Name"
            rules={[{ max: NAME_MAX, message: `At most ${NAME_MAX} characters` }]}
          >
            <Input autoComplete="off" placeholder="Full name, as it will appear in the app" />
          </Form.Item>

          <Form.Item name="locale" label="Locale">
            <Select
              options={LOCALE_OPTIONS}
              allowClear
              placeholder="Select a locale"
            />
          </Form.Item>

          <Typography.Text type="secondary" className="text-xs">
            Both are required by the account; whatever you leave blank, the person fills in when they
            first sign in.
          </Typography.Text>

          <Form.Item
            name="note"
            label="Note"
            tooltip="For your own record. Never shown to the person."
            rules={[{ max: NOTE_MAX, message: `At most ${NOTE_MAX} characters` }]}
          >
            <Input.TextArea
              rows={3}
              maxLength={NOTE_MAX}
              showCount
              placeholder="Beta tester, friend of…"
            />
          </Form.Item>

          <Typography.Text type="secondary" className="text-xs">
            The account is created in the customer pool straight away. Cognito emails the temporary
            password; the person signs in with it and sets their own.
          </Typography.Text>
        </FormSection>
      </Form>
    </Drawer>
  );
}
