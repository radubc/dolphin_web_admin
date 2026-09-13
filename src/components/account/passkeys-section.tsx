"use client";

/**
 * "Passkeys" in the Account & security drawer: the credentials registered
 * against the caller's own Cognito account, with a delete on each and a form
 * to add one.
 *
 * Cognito is the WebAuthn relying party. It issues the challenge
 * (`StartWebAuthnRegistration`), the browser runs the ceremony, and Cognito
 * verifies the attestation (`CompleteWebAuthnRegistration`). Nothing about a
 * passkey is stored by this app or in either database.
 *
 * **Naming.** Cognito derives `FriendlyCredentialName` from the authenticator
 * itself and offers no way to set it — neither call takes a name — so the name
 * typed here is used only in the confirmation message. It is kept because it
 * is what people expect to be asked, and because a stored label would need a
 * table of our own; that is a follow-up, noted in `docs/auth.md`.
 *
 * The admin pool has no WebAuthn relying party configured and is below the
 * Essentials tier, so every call is refused today. The section stays visible
 * and shows Cognito's own sentence rather than hiding itself.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  List,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from "antd";
import { DeleteOutlined, KeyOutlined } from "@ant-design/icons";
import {
  FormErrorSummary,
  useFormErrorSummary,
} from "@/components/form-error-summary";
import { accountApi } from "@/lib/account/client";
import type { Passkey } from "@/lib/account/types";
import { createPasskey, passkeysSupported } from "@/lib/account/webauthn";
import { errorMessage, formatDateTimeOrDash } from "@/lib/format";

interface AddFields {
  name?: string;
}

/** No-op subscribe: whether WebAuthn exists never changes within a page. */
const NEVER_CHANGES = () => () => {};

/** Server snapshot: assume support, so the button is not hidden in the HTML. */
const ALWAYS_SUPPORTED_ON_SERVER = () => true;

/** What the browser throws when the person dismisses the system sheet. */
function wasCancelled(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

export default function PasskeysSection() {
  const { message } = App.useApp();
  const [form] = Form.useForm<AddFields>();

  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Nothing here is mandatory today, but the wiring is the app's convention and
  // it is what makes a rule added to this form report itself like every other.
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();

  /**
   * Whether this browser can create a passkey at all.
   *
   * `useSyncExternalStore` rather than an effect: `navigator.credentials` does
   * not exist on the server, so the server snapshot is an optimistic `true`
   * and the real answer arrives on the client's first pass — no hydration
   * mismatch, and no `setState` in an effect. Nothing ever changes the value,
   * hence the no-op subscribe.
   */
  const supported = useSyncExternalStore(
    NEVER_CHANGES,
    passkeysSupported,
    ALWAYS_SUPPORTED_ON_SERVER,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPasskeys(await accountApi.passkeys.list());
      setError(null);
    } catch (cause) {
      setPasskeys([]);
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  // Written out rather than calling `load()`: every state update has to happen
  // in a promise callback, because a `setState` in the body of an effect is a
  // cascading render. `load()` is still what the buttons below use.
  useEffect(() => {
    let cancelled = false;
    void accountApi.passkeys
      .list()
      .then((list) => {
        if (cancelled) return;
        setPasskeys(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPasskeys([]);
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async (values: AddFields) => {
    setError(null);
    reset();
    setBusy(true);
    try {
      const options = await accountApi.passkeys.start();
      const credential = await createPasskey(options);
      await accountApi.passkeys.complete(credential);
      form.resetFields();
      const name = values.name?.trim();
      message.success(name ? `${name} added.` : "Passkey added.");
      await load();
    } catch (cause) {
      if (wasCancelled(cause)) {
        message.info("Passkey setup cancelled.");
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (passkey: Passkey) => {
    setError(null);
    setBusy(true);
    try {
      await accountApi.passkeys.remove(passkey.id);
      message.success(`${passkey.name} removed.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert
          type="warning"
          showIcon
          title="Cognito refused that"
          description={error}
          role="alert"
        />
      ) : null}

      {!supported ? (
        <Alert
          type="info"
          showIcon
          title="This browser cannot create passkeys."
          description="Use a browser with WebAuthn support to add one; the list above still works."
        />
      ) : null}

      <List<Passkey>
        size="small"
        loading={loading}
        dataSource={passkeys}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No passkeys registered."
            />
          ),
        }}
        renderItem={(passkey) => (
          <List.Item
            actions={[
              <Popconfirm
                key="delete"
                title="Remove this passkey"
                description="You will not be able to sign in with it again."
                okText="Remove"
                okButtonProps={{ danger: true }}
                onConfirm={() => remove(passkey)}
              >
                <Button
                  type="text"
                  danger
                  size="small"
                  disabled={busy}
                  icon={<DeleteOutlined />}
                  aria-label={`Remove ${passkey.name}`}
                />
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              avatar={<KeyOutlined aria-hidden />}
              title={
                <Space size={6}>
                  <span>{passkey.name}</span>
                  {passkey.attachment ? (
                    <Tag>{passkey.attachment}</Tag>
                  ) : null}
                </Space>
              }
              description={
                <Typography.Text type="secondary" className="text-xs">
                  Added {formatDateTimeOrDash(passkey.createdAt)}
                  {passkey.relyingPartyId ? ` · ${passkey.relyingPartyId}` : ""}
                </Typography.Text>
              }
            />
          </List.Item>
        )}
      />

      <Form<AddFields>
        form={form}
        layout="vertical"
        onFinish={add}
        onFinishFailed={onFinishFailed}
        disabled={busy}
      >
        <FormErrorSummary
          summary={errorSummary}
          onClose={reset}
          style={{ marginBottom: 16 }}
        />

        <Form.Item
          name="name"
          label="Passkey name"
          htmlFor="passkey-name"
          extra="Optional. Cognito names a passkey after the authenticator that created it, so this is only used to confirm what you added."
        >
          <Input
            id="passkey-name"
            placeholder="MacBook Touch ID"
            maxLength={60}
            style={{ maxWidth: 280 }}
          />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Button
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={busy || !supported}
            icon={<KeyOutlined />}
          >
            Add passkey
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
