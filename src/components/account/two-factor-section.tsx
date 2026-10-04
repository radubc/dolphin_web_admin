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
 *   the factor disabled (and passkey MFA with it).
 * - **Refused** — a pool with `MfaConfiguration OFF` declines (the admin pool
 *   has been `OPTIONAL` since 2026-09-12). The section stays visible and shows
 *   Cognito's own sentence: it names the pool setting that is missing, which
 *   is what the owner needs. See `docs/auth.md` for the commands.
 *
 * A passkey counts as both factors once the per-user flag is set
 * (`src/lib/account/passkey-mfa.ts`); while an account has the app on, a
 * passkey and no flag, `passkeySignInPaused` shows a warning, re-read when the
 * section below adds or removes a passkey (`PASSKEYS_CHANGED_EVENT`).
 *
 * ## The QR image (phase B, 2026-10-04)
 *
 * The `otpauth://` URI is drawn as a QR code with antd's own `QRCode` (no
 * extra dependency: antd 6 ships `@rc-component/qrcode`), rendered
 * client-side from the URI the server returned, so the secret still travels
 * exactly once and is never sent anywhere else to be encoded. Below it the
 * secret and the full link stay as copy-to-clipboard text, which every
 * authenticator accepts — for a phone that cannot scan the screen it is on,
 * or a desktop app.
 *
 * ## Recovery codes (phase B, 2026-10-04)
 *
 * The verify answer carries ten single-use recovery codes
 * (`docs/two-factor-plan.md`), shown **once** in a dialog with Copy and
 * Download and closed only by "I've saved my codes"; they are dropped from
 * state the moment it closes. Under the authenticator row a **Recovery
 * codes** row says how many are left and offers **Generate new codes**, which
 * asks for the password (`POST /api/v1/admin/me/mfa/recovery-codes`) and
 * shows the same dialog. When the factor is off and the server still holds
 * rows, a banner says who turned it off — a recovery code, or support with a
 * CLI reset — and asks for the authenticator to be set up again.
 */

import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  QRCode,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  CopyOutlined,
  DownloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  FormErrorSummary,
  useFormErrorSummary,
} from "@/components/form-error-summary";
import { accountApi, fieldErrorsFrom } from "@/lib/account/client";
import type { MfaStatusView, TotpEnrolment } from "@/lib/account/types";
import { errorMessage } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { PASSKEYS_CHANGED_EVENT } from "./passkeys-section";

interface CodeFields {
  code: string;
}

/** Codes per set; the row reads "N of 10 left". */
const RECOVERY_CODE_COUNT = 10;

/** The file "Download" saves. */
const RECOVERY_CODES_FILENAME = "fairsums-admin-recovery-codes.txt";

/** The API code a wrong password comes back with (401). */
const PASSWORD_INCORRECT = "password_incorrect";

/** `2026-10-04T…` → `Oct 4, 2026`, in the browser's own locale and zone. */
function formatUsedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The error code an `apiFetch` failure carries, if any. */
function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export default function TwoFactorSection() {
  const { message } = App.useApp();
  const [form] = Form.useForm<CodeFields>();

  const [status, setStatus] = useState<MfaStatusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [busy, setBusy] = useState(false);
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();

  // The ten codes, held only while their dialog is open: `null` otherwise.
  const [codes, setCodes] = useState<string[] | null>(null);
  // Enrolment succeeded but the codes could not be written: offer to make them.
  const [codesMissing, setCodesMissing] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [regeneratePassword, setRegeneratePassword] = useState("");
  const [regeneratePasswordError, setRegeneratePasswordError] = useState<string | null>(null);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

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

  // A passkey added or removed in the section below can start or end the
  // paused state, so the status is read again. Every state update happens in
  // a promise callback from an event handler, never in the effect's own pass.
  useEffect(() => {
    const onPasskeysChanged = () => {
      void accountApi.mfa
        .status()
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((cause: unknown) => {
          setError(errorMessage(cause));
        });
    };
    window.addEventListener(PASSKEYS_CHANGED_EVENT, onPasskeysChanged);
    return () => {
      window.removeEventListener(PASSKEYS_CHANGED_EVENT, onPasskeysChanged);
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
      const result = await accountApi.mfa.verifyTotp({ code: values.code });
      setStatus(result);
      setEnrolment(null);
      form.resetFields();
      message.success("Two-factor authentication is on.");
      // The codes are shown once, right here; nothing returns them again.
      if (result.issuedRecoveryCodes && result.issuedRecoveryCodes.length > 0) {
        setCodes(result.issuedRecoveryCodes);
        setCodesMissing(false);
      } else {
        setCodesMissing(true);
      }
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
      setCodesMissing(false);
      message.success("Two-factor authentication is off.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------- Recovery codes */

  /** The dialog's only way out: the codes leave component state with it. */
  const closeCodes = () => {
    setCodes(null);
  };

  const copyCodes = async () => {
    if (codes === null) return;
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      message.success("Recovery codes copied.");
    } catch (cause) {
      console.error("[account] copying the recovery codes failed.", cause);
      message.error("The codes could not be copied. Select and copy them by hand.");
    }
  };

  /** A text file from a Blob URL: no server round trip, nothing stored. */
  const downloadCodes = () => {
    if (codes === null) return;
    const lines = [
      "FairSums Admin two-factor recovery codes",
      `Saved ${new Date().toLocaleDateString()}`,
      "",
      "Each code signs you in once if you lose your authenticator app.",
      "Keep this file somewhere safe and private.",
      "",
      ...codes,
      "",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = RECOVERY_CODES_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const openRegenerate = () => {
    setRegeneratePassword("");
    setRegeneratePasswordError(null);
    setRegenerateError(null);
    setRegenerateOpen(true);
  };

  const closeRegenerate = () => {
    setRegenerateOpen(false);
    // The password is a credential: not kept once the dialog is gone.
    setRegeneratePassword("");
    setRegeneratePasswordError(null);
    setRegenerateError(null);
  };

  const regenerate = async () => {
    if (regeneratePassword === "") {
      setRegeneratePasswordError("Password is required");
      return;
    }
    setRegenerating(true);
    setRegeneratePasswordError(null);
    setRegenerateError(null);
    try {
      const result = await accountApi.mfa.regenerateRecoveryCodes({
        password: regeneratePassword,
      });
      closeRegenerate();
      setCodesMissing(false);
      setCodes(result.recoveryCodes);
      message.success("New recovery codes generated. Your old codes no longer work.");
      // The row's count: a fresh set is ten of ten.
      setStatus((current) =>
        current === null
          ? current
          : {
              ...current,
              recoveryCodes: {
                remaining: result.recoveryCodes.length,
                total: result.recoveryCodes.length,
                usedAt: null,
              },
            },
      );
    } catch (cause) {
      if (errorCode(cause) === PASSWORD_INCORRECT) {
        setRegeneratePasswordError(errorMessage(cause));
        return;
      }
      setRegenerateError(errorMessage(cause));
    } finally {
      setRegenerating(false);
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
  const recovery = status?.recoveryCodes;
  // The factor is off and the server still holds rows: a recovery code was
  // redeemed, or support turned the factor off at Cognito (a CLI reset leaves
  // the unused rows behind). The next enrolment clears it.
  const resetBanner =
    status !== null && !on && recovery !== undefined && recovery.total > 0
      ? recovery.usedAt !== null
        ? `Two-factor authentication was turned off with a recovery code on ${formatUsedAt(
            recovery.usedAt,
          )}. Set up your authenticator app again.`
        : "Two-factor authentication was turned off by support. Set up your authenticator app again."
      : null;

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

      {resetBanner !== null ? (
        <Alert type="warning" showIcon title={resetBanner} role="status" />
      ) : null}

      {status?.passkeySignInPaused === true ? (
        <Alert
          type="warning"
          showIcon
          title="Passkey sign-in is paused while two-factor authentication is on. Until an upcoming update, sign in with your password and authenticator code."
          role="alert"
        />
      ) : null}

      {enrolment === null ? (
        <>
          <Typography.Text type="secondary" className="text-sm">
            {on
              ? "You are asked for a six-digit code from your authenticator app every time you sign in with your password. "
              : "Add a second step to password sign-in: a six-digit code from an authenticator app such as 1Password, Authy or Google Authenticator. "}
            A passkey signs you in on its own and counts as two factors. The
            authenticator app protects password sign-in.
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

          {/* Only while the factor is on: codes without a factor to recover
              from are noise, and the server refuses to mint them. */}
          {on ? (
            <div
              className="flex flex-col gap-2 rounded-md p-3"
              style={{
                backgroundColor: surfaceColors.page,
                border: `1px solid ${surfaceColors.separator}`,
              }}
            >
              <div className="flex items-center gap-2">
                <Typography.Text type="secondary">Recovery codes</Typography.Text>
                {codesMissing ? (
                  <Tag color="red">Not created</Tag>
                ) : (
                  <Tag>
                    {recovery?.remaining ?? 0} of {RECOVERY_CODE_COUNT} left
                  </Tag>
                )}
              </div>
              <Typography.Text type="secondary" className="text-sm">
                {codesMissing
                  ? "Your recovery codes couldn't be created. Generate them now."
                  : "Each code signs you in once if you lose your authenticator app. Generating new codes replaces the ones you saved."}
              </Typography.Text>
              <Space>
                <Button onClick={openRegenerate} disabled={busy}>
                  Generate new codes
                </Button>
              </Space>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <Typography.Text type="secondary" className="text-sm">
            Add this to your authenticator app, then type the six-digit code it
            shows. The secret is displayed once and is not stored anywhere by
            this console.
          </Typography.Text>

          <div className="flex flex-col items-center">
            {/* SVG, not canvas: crisp at any zoom, and nothing to rasterise
                before the drawer paints. Level M tolerates a smudged screen;
                the URI is short enough that it costs no size. */}
            <QRCode
              value={enrolment.uri}
              size={180}
              type="svg"
              errorLevel="M"
              aria-label="QR code to add this account to an authenticator app"
            />
            <Typography.Text type="secondary" className="mt-2 text-center text-sm">
              Scan with your authenticator app, or enter the key below.
            </Typography.Text>
          </div>

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

      {/* --------------------------------------------------- Recovery codes */}
      <Modal
        open={codes !== null}
        title="Save your recovery codes"
        // The only way out is the button below: the codes are shown once.
        closable={false}
        mask={{ closable: false }}
        keyboard={false}
        footer={
          <Button type="primary" onClick={closeCodes}>
            I&apos;ve saved my codes
          </Button>
        }
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" className="text-sm">
          If you lose your authenticator app, one of these codes signs you in
          with your password. Each code works once, and they are shown only
          now. Keep them somewhere safe, like a password manager.
        </Typography.Paragraph>

        <div
          className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md px-4 py-3 font-mono text-sm"
          style={{
            backgroundColor: surfaceColors.page,
            border: `1px solid ${surfaceColors.separator}`,
          }}
          aria-label="Recovery codes"
          role="list"
        >
          {(codes ?? []).map((code) => (
            <div key={code} role="listitem" className="tracking-wide select-all">
              {code}
            </div>
          ))}
        </div>

        <Space className="mt-3" size={8}>
          <Button icon={<CopyOutlined />} onClick={() => void copyCodes()}>
            Copy
          </Button>
          <Button icon={<DownloadOutlined />} onClick={downloadCodes}>
            Download
          </Button>
        </Space>
      </Modal>

      {/* -------------------------------------------- Generate new codes */}
      <Modal
        open={regenerateOpen}
        title="Generate new recovery codes?"
        okText="Generate new codes"
        okButtonProps={{ loading: regenerating }}
        cancelButtonProps={{ disabled: regenerating }}
        mask={{ closable: !regenerating }}
        closable={!regenerating}
        keyboard={!regenerating}
        onCancel={closeRegenerate}
        onOk={() => void regenerate()}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" className="text-sm">
          You will get ten new codes, and the ones you saved before will stop
          working.
        </Typography.Paragraph>

        {regenerateError !== null ? (
          <Alert
            type="error"
            showIcon
            title={regenerateError}
            role="alert"
            style={{ marginBottom: 12 }}
          />
        ) : null}

        <Typography.Paragraph className="text-sm" style={{ marginBottom: 8 }}>
          Enter your password to confirm.
        </Typography.Paragraph>
        <Input.Password
          value={regeneratePassword}
          onChange={(event) => {
            setRegeneratePassword(event.target.value);
            setRegeneratePasswordError(null);
          }}
          disabled={regenerating}
          // The browser may offer the saved password; it must not save this one
          // as a new credential.
          autoComplete="current-password"
          aria-label="Your password"
          aria-invalid={regeneratePasswordError !== null}
          status={regeneratePasswordError === null ? undefined : "error"}
          onPressEnter={() => void regenerate()}
        />
        {regeneratePasswordError !== null ? (
          <Typography.Text type="danger" className="text-sm">
            {regeneratePasswordError}
          </Typography.Text>
        ) : null}
      </Modal>
    </div>
  );
}
