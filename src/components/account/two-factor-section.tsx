"use client";

/**
 * "Two-factor authentication" in the Account & security drawer.
 *
 * Three states, driven by what Cognito says about the caller's own account:
 *
 * - **Off** — a "Set up authenticator app" button. Pressing it calls
 *   `AssociateSoftwareToken`, which mints a shared secret; the secret and its
 *   `otpauth://` URI are shown once, and a six-digit code from the app then
 *   proves it arrived (`VerifySoftwareToken`) before the factor is switched on
 *   (`SetUserMFAPreference`).
 * - **On** — a "Turn off" button, which is `SetUserMFAPreference` again with
 *   the factor disabled.
 * - **Refused** — the admin pool's `MfaConfiguration` is `OFF` today, so AWS
 *   declines. The section stays visible and shows Cognito's own sentence: it
 *   names the pool setting that is missing, which is what the owner needs. See
 *   `docs/auth.md` for the commands that switch it on.
 *
 * No QR image: `qrcode` is not a dependency of this app, and adding one to
 * render a picture of a string the user can already copy was not worth it.
 * The `otpauth://` URI is offered as copyable text — every authenticator app
 * accepts a pasted URI or a typed secret — and drawing it as a QR is a
 * follow-up if the owner wants it.
 */

import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, Popconfirm, Space, Tag, Typography } from "antd";
import { CheckCircleOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import {
  FormErrorSummary,
  useFormErrorSummary,
} from "@/components/form-error-summary";
import { accountApi, fieldErrorsFrom } from "@/lib/account/client";
import type { MfaStatus, TotpEnrolment } from "@/lib/account/types";
import { errorMessage } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";

interface CodeFields {
  code: string;
}

export default function TwoFactorSection() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CodeFields>();

  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [busy, setBusy] = useState(false);
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();

  /**
   * The status is read once, when the drawer mounts, and then kept up to date
   * by the two writes below — both `verifyTotp` and `disableTotp` answer with
   * the fresh status, so there is never a reason to ask again.
   *
   * Written out rather than wrapped in a helper because every state update has
   * to happen inside a promise callback: a `setState` in the body of an effect
   * is a cascading render, and this project's lint rules say so.
   */
  useEffect(() => {
    let cancelled = false;
    void accountApi.mfa
      .status()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      setEnrolment(await accountApi.mfa.startTotp());
      form.resetFields();
      reset();
    } catch (cause) {
      // Includes the "not switched on for this user pool" refusal, quoted from
      // Cognito by the server.
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (values: CodeFields) => {
    setError(null);
    reset();
    setBusy(true);
    try {
      setStatus(await accountApi.mfa.verifyTotp({ code: values.code }));
      setEnrolment(null);
      form.resetFields();
      message.success("Two-factor authentication is on.");
    } catch (cause) {
      const fieldErrors = fieldErrorsFrom(cause);
      if (fieldErrors.code) {
        form.setFields([{ name: "code", errors: [fieldErrors.code] }]);
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setError(null);
    setBusy(true);
    try {
      setStatus(await accountApi.mfa.disableTotp());
      message.success("Two-factor authentication is off.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelEnrolment = () => {
    // The secret Cognito minted is simply abandoned: it was never verified, so
    // it can never be used to sign in, and the next attempt mints another.
    setEnrolment(null);
    setError(null);
    form.resetFields();
    reset();
  };

  const on = status?.totpEnabled === true;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Typography.Text type="secondary">Authenticator app</Typography.Text>
        {loading ? (
          <Tag>Checking…</Tag>
        ) : on ? (
          <Tag color="green" icon={<CheckCircleOutlined />}>
            On
          </Tag>
        ) : (
          <Tag>Off</Tag>
        )}
      </div>

      {error ? (
        <Alert
          type="warning"
          showIcon
          title="Cognito refused that"
          description={error}
          role="alert"
        />
      ) : null}

      {enrolment === null ? (
        <>
          <Typography.Text type="secondary" className="text-sm">
            {on
              ? "You are asked for a six-digit code from your authenticator app every time you sign in."
              : "Add a second step to sign-in: a six-digit code from an authenticator app such as 1Password, Authy or Google Authenticator."}
          </Typography.Text>
          <Space>
            {on ? (
              <Popconfirm
                title="Turn off two-factor authentication?"
                description="Your password alone will sign you in again."
                okText="Turn off"
                okButtonProps={{ danger: true }}
                onConfirm={turnOff}
              >
                <Button danger loading={busy}>
                  Turn off
                </Button>
              </Popconfirm>
            ) : (
              <Button
                type="primary"
                icon={<SafetyCertificateOutlined />}
                loading={busy}
                onClick={start}
              >
                Set up authenticator app
              </Button>
            )}
          </Space>
        </>
      ) : (
        <>
          <Typography.Text type="secondary" className="text-sm">
            Add this to your authenticator app, then type the six-digit code it
            shows. The secret is displayed once and is not stored anywhere by
            this console.
          </Typography.Text>

          <div
            className="flex flex-col gap-2 rounded-md p-3"
            style={{
              backgroundColor: surfaceColors.page,
              border: `1px solid ${surfaceColors.separator}`,
            }}
          >
            <div className="flex flex-col gap-1">
              <Typography.Text type="secondary" className="text-xs">
                Secret
              </Typography.Text>
              <Typography.Text code copyable className="break-all">
                {enrolment.secret}
              </Typography.Text>
            </div>
            <div className="flex flex-col gap-1">
              <Typography.Text type="secondary" className="text-xs">
                Setup link ({enrolment.issuer} · {enrolment.account})
              </Typography.Text>
              <Typography.Text
                copyable={{ text: enrolment.uri }}
                className="break-all text-xs"
              >
                {enrolment.uri}
              </Typography.Text>
            </div>
          </div>

          <Form<CodeFields>
            form={form}
            layout="vertical"
            onFinish={verify}
            onFinishFailed={onFinishFailed}
            disabled={busy}
          >
            <FormErrorSummary
              summary={errorSummary}
              onClose={reset}
              style={{ marginBottom: 16 }}
            />

            <Form.Item
              name="code"
              label="Verification code"
              htmlFor="totp-code"
              rules={[
                { required: true },
                {
                  pattern: /^\s*\d{3}\s?-?\s?\d{3}\s*$/,
                  message: "Enter the six digits from your app.",
                },
              ]}
            >
              <Input
                id="totp-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={7}
                placeholder="123456"
                style={{ maxWidth: 200 }}
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <Space>
                <Button type="primary" htmlType="submit" loading={busy}>
                  Verify and turn on
                </Button>
                <Button onClick={cancelEnrolment} disabled={busy}>
                  Cancel
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </>
      )}

      {status !== null && status.methods.length > 0 ? (
        <Typography.Text type="secondary" className="text-xs">
          Factors Cognito has on file: {status.methods.join(", ")}
          {status.preferred ? ` · preferred: ${status.preferred}` : ""}
        </Typography.Text>
      ) : null}
    </div>
  );
}
