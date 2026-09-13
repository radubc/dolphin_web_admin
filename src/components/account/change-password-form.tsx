"use client";

/**
 * "Password" in the Account & security drawer: current, new, confirm.
 *
 * Cognito checks the current password, so this form *is* the re-authentication
 * for the change; there is no separate confirm-identity step. The pool owns the
 * complexity policy and its message is what lands on the new-password input, so
 * nothing here restates the rules beyond the eight-character floor no Cognito
 * pool can go below.
 *
 * Forms convention (both apps): no required asterisk, every mandatory field
 * declares `rules={[{ required: true }]}` and takes its message from the
 * `ConfigProvider` (`<Label> is required`), the message shows inline under the
 * field, a failed submit scrolls to the first bad field and the summary at the
 * top names them. The submit button is never the only signal — it stays
 * clickable and the errors appear.
 */

import { useState } from "react";
import { Alert, App, Button, Form, Input } from "antd";
import { LockOutlined } from "@ant-design/icons";
import {
  FormErrorSummary,
  useFormErrorSummary,
} from "@/components/form-error-summary";
import { accountApi, fieldErrorsFrom } from "@/lib/account/client";
import { errorMessage } from "@/lib/format";

interface PasswordFields {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/** Cognito's own floor; the pool's real policy is stricter and it says so. */
const MIN_PASSWORD_LENGTH = 8;

/** Which inputs the server may pin a message to. */
const SERVER_FIELDS = ["currentPassword", "newPassword"] as const;

export default function ChangePasswordForm() {
  const { message } = App.useApp();
  const [form] = Form.useForm<PasswordFields>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();

  const handleSubmit = async (values: PasswordFields) => {
    setError(null);
    reset();
    setSaving(true);
    try {
      await accountApi.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      form.resetFields();
      message.success("Your password has been changed.");
    } catch (cause) {
      // A 422 from the service names the input it is about; anything else is a
      // banner above the form.
      const fieldErrors = fieldErrorsFrom(cause);
      const pinned = SERVER_FIELDS.filter((name) => fieldErrors[name]);
      if (pinned.length > 0) {
        form.setFields(
          pinned.map((name) => ({ name, errors: [fieldErrors[name]] })),
        );
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form<PasswordFields>
      form={form}
      layout="vertical"
      onFinish={handleSubmit}
      onFinishFailed={onFinishFailed}
      disabled={saving}
    >
      <FormErrorSummary
        summary={errorSummary}
        onClose={reset}
        style={{ marginBottom: 16 }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          title={error}
          role="alert"
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Form.Item
        name="currentPassword"
        label="Current password"
        htmlFor="current-password"
        rules={[{ required: true }]}
      >
        <Input.Password
          id="current-password"
          autoComplete="current-password"
          placeholder="Your current password"
          prefix={<LockOutlined aria-hidden />}
        />
      </Form.Item>

      <Form.Item
        name="newPassword"
        label="New password"
        htmlFor="new-password"
        rules={[
          { required: true },
          {
            min: MIN_PASSWORD_LENGTH,
            message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
          },
        ]}
      >
        <Input.Password
          id="new-password"
          autoComplete="new-password"
          placeholder="Your new password"
          prefix={<LockOutlined aria-hidden />}
        />
      </Form.Item>

      <Form.Item
        name="confirmPassword"
        label="Confirm new password"
        htmlFor="confirm-password"
        dependencies={["newPassword"]}
        rules={[
          { required: true },
          ({ getFieldValue }) => ({
            validator(_rule, value: string | undefined) {
              if (!value || getFieldValue("newPassword") === value) {
                return Promise.resolve();
              }
              return Promise.reject(new Error("Both passwords must match."));
            },
          }),
        ]}
      >
        <Input.Password
          id="confirm-password"
          autoComplete="new-password"
          placeholder="Repeat the new password"
          prefix={<LockOutlined aria-hidden />}
        />
      </Form.Item>

      <Form.Item style={{ marginBottom: 0 }}>
        <Button type="primary" htmlType="submit" loading={saving}>
          Change password
        </Button>
      </Form.Item>
    </Form>
  );
}
