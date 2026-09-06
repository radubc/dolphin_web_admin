"use client";

/**
 * Invite / Edit admin user.
 *
 * Invite: email, display name, roles and (for a super-admin) the super-admin
 * switch. The real implementation creates the Cognito user in the admin pool,
 * which emails the temporary password; the row here is the allowlist entry.
 *
 * Edit: the same fields with the email locked (it is the Cognito identity),
 * plus Disable / Enable in the footer. Anyone who can see the list can open
 * the form; only a super-admin can save, so the fields are read-only otherwise.
 *
 * Standalone by design: `open`, the user or null, the roles, the capabilities
 * and the callbacks. The page and the shell's quick action both mount it.
 */

import { useMemo, useState } from "react";
import { Alert, Button, Drawer, Form, Input, Popconfirm, Select, Space, Switch, Typography } from "antd";
import { CheckCircleOutlined, StopOutlined, UserAddOutlined, UserOutlined } from "@ant-design/icons";
import FormSection from "@/components/form-section";
import type {
  AdminCapabilities,
  AdminRole,
  AdminUser,
  CreateAdminUserInput,
  UpdateAdminUserInput,
} from "@/lib/admin-access/types";
import { errorMessage, trimToNull } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { ACCESS_COLOR } from "./access-meta";

/** Save lives in the footer, outside the form, and submits by association. */
const FORM_NAME = "admin-user-form";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserFormValues {
  email: string;
  displayName: string;
  roleKeys: string[];
  isSuperAdmin: boolean;
}

export interface UserFormDrawerProps {
  open: boolean;
  /** Null while inviting. */
  user: AdminUser | null;
  roles: readonly AdminRole[];
  capabilities: Pick<AdminCapabilities, "userId" | "isSuperAdmin">;
  onClose: () => void;
  onCreate: (input: CreateAdminUserInput) => Promise<unknown>;
  onUpdate: (id: string, input: UpdateAdminUserInput) => Promise<unknown>;
  /** Omit to hide the Disable / Enable control. */
  onSetDisabled?: (id: string, disabled: boolean) => Promise<unknown>;
}

function UserFormBody({
  user,
  roles,
  readOnly,
  canGrantSuperAdmin,
  busy,
  error,
  onDismissError,
  onDraftChange,
  onSubmit,
  onInvalid,
}: {
  user: AdminUser | null;
  roles: readonly AdminRole[];
  readOnly: boolean;
  canGrantSuperAdmin: boolean;
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onDraftChange: (canSave: boolean) => void;
  onSubmit: (values: UserFormValues) => void;
  onInvalid: () => void;
}) {
  const [form] = Form.useForm<UserFormValues>();

  const initialValues = useMemo<UserFormValues>(
    () => ({
      email: user?.email ?? "",
      displayName: user?.displayName ?? "",
      roleKeys: user?.roleKeys ?? [],
      isSuperAdmin: user?.isSuperAdmin ?? false,
    }),
    [user],
  );

  const roleOptions = useMemo(
    () =>
      roles.map((role) => ({
        value: role.key,
        label: role.name,
        title: role.description ?? undefined,
      })),
    [roles],
  );

  const isSuperAdmin = Form.useWatch("isSuperAdmin", form) ?? initialValues.isSuperAdmin;

  return (
    <Form<UserFormValues>
      form={form}
      name={FORM_NAME}
      layout="vertical"
      requiredMark
      disabled={busy || readOnly}
      initialValues={initialValues}
      onValuesChange={(_changed, next: UserFormValues) => {
        onDraftChange((next.email ?? "").trim() !== "");
      }}
      onFinish={onSubmit}
      onFinishFailed={onInvalid}
      scrollToFirstError
      className="flex flex-col gap-4"
    >
      {error === null ? null : (
        <Alert type="error" showIcon title={error} closable={{ onClose: onDismissError }} />
      )}

      {readOnly && (
        <Alert
          type="info"
          showIcon
          title="Read-only. Only a super-admin can change admin access."
        />
      )}

      <FormSection title="Operator" icon={<UserOutlined />} color={ACCESS_COLOR}>
        <Form.Item
          name="email"
          label="Email"
          tooltip={
            user
              ? "The Cognito identity. It cannot be changed here; invite a new user instead."
              : "The address the invitation goes to. It becomes their sign-in."
          }
          rules={[
            { required: true, whitespace: true, message: "Email is required" },
            {
              validator: (_rule, value: string) =>
                !value || EMAIL_PATTERN.test(value.trim())
                  ? Promise.resolve()
                  : Promise.reject(new Error("Enter a valid email address")),
            },
          ]}
        >
          <Input
            type="email"
            autoComplete="off"
            placeholder="operator@example.com"
            maxLength={320}
            disabled={user !== null}
          />
        </Form.Item>

        <Form.Item
          name="displayName"
          label="Display name"
          className="mb-0"
          tooltip="Shown in the list and in the audit log. Optional; their email stands in when empty."
        >
          <Input placeholder="e.g., Maya Chen" maxLength={120} />
        </Form.Item>
      </FormSection>

      <FormSection title="Access" icon={<UserAddOutlined />} color={ACCESS_COLOR}>
        <Form.Item
          name="roleKeys"
          label="Roles"
          tooltip="Their permissions are the union of every role's actions. No role means no access to anything."
        >
          <Select
            mode="multiple"
            allowClear
            placeholder={isSuperAdmin ? "Not needed for a super-admin" : "Choose one or more roles"}
            options={roleOptions}
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item
          name="isSuperAdmin"
          label="Super-admin"
          valuePropName="checked"
          className="mb-0"
          tooltip="Bypasses every action check and may manage users, roles and grants. Grant sparingly."
        >
          <Switch disabled={!canGrantSuperAdmin} />
        </Form.Item>
        {isSuperAdmin && (
          <Typography.Text type="secondary" className="text-xs">
            A super-admin is allowed everything regardless of roles.
          </Typography.Text>
        )}
      </FormSection>

      {user && (
        <div className="flex flex-col gap-1 px-1 text-xs" style={{ color: surfaceColors.textTertiary }}>
          <span>Cognito subject: {user.cognitoSub}</span>
        </div>
      )}
    </Form>
  );
}

export default function UserFormDrawer({
  open,
  user,
  roles,
  capabilities,
  onClose,
  onCreate,
  onUpdate,
  onSetDisabled,
}: UserFormDrawerProps) {
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ key: string; canSave: boolean } | null>(null);

  const isEdit = user !== null;
  const isSelf = user?.id === capabilities.userId;
  const readOnly = !capabilities.isSuperAdmin;
  const formKey = user?.id ?? "invite";
  const busy = saving || toggling;
  const canSave = !readOnly && (draft !== null && draft.key === formKey ? draft.canSave : isEdit);
  const disabled = user?.disabledAt !== null && user !== null;

  const handleSubmit = async (values: UserFormValues) => {
    setError(null);
    setSaving(true);
    try {
      if (user === null) {
        await onCreate({
          email: values.email.trim(),
          displayName: trimToNull(values.displayName),
          roleKeys: values.roleKeys ?? [],
          isSuperAdmin: values.isSuperAdmin ?? false,
        });
      } else {
        const input: UpdateAdminUserInput = {};
        const displayName = trimToNull(values.displayName);
        if (displayName !== user.displayName) input.displayName = displayName;
        const roleKeys = [...(values.roleKeys ?? [])].sort();
        if (roleKeys.join(",") !== [...user.roleKeys].sort().join(",")) input.roleKeys = roleKeys;
        if ((values.isSuperAdmin ?? false) !== user.isSuperAdmin) {
          input.isSuperAdmin = values.isSuperAdmin ?? false;
        }
        if (Object.keys(input).length > 0) {
          await onUpdate(user.id, input);
        }
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (user === null || onSetDisabled === undefined) return;
    setError(null);
    setToggling(true);
    try {
      await onSetDisabled(user.id, !disabled);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setToggling(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      size={600}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2">
          {isEdit ? (
            <UserOutlined style={{ fontSize: 18, color: ACCESS_COLOR }} />
          ) : (
            <UserAddOutlined style={{ fontSize: 18, color: ACCESS_COLOR }} />
          )}
          <span>{isEdit ? "Edit admin user" : "Invite user"}</span>
        </span>
      }
      afterOpenChange={(opened) => {
        if (!opened) {
          setError(null);
          setDraft(null);
        }
      }}
      styles={{ body: { background: surfaceColors.page } }}
      footer={
        <div className="flex items-center justify-between">
          {isEdit && onSetDisabled !== undefined && !readOnly ? (
            <Popconfirm
              title={disabled ? "Enable admin user" : "Disable admin user"}
              description={
                isSelf
                  ? "You cannot disable your own account."
                  : disabled
                    ? "They will be able to sign in again with their existing roles."
                    : "They will be signed out on their next request and cannot sign in. The row stays for the audit trail."
              }
              okText={disabled ? "Enable" : "Disable"}
              cancelText="Cancel"
              okButtonProps={{ danger: !disabled, loading: toggling, disabled: isSelf }}
              onConfirm={() => {
                void handleToggle();
              }}
            >
              <Button
                danger={!disabled}
                icon={disabled ? <CheckCircleOutlined /> : <StopOutlined />}
                disabled={busy || isSelf}
              >
                {disabled ? "Enable" : "Disable"}
              </Button>
            </Popconfirm>
          ) : (
            <span />
          )}

          <Space>
            <Button onClick={onClose} disabled={busy}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button
                type="primary"
                htmlType="submit"
                form={FORM_NAME}
                disabled={!canSave || busy}
                loading={saving}
              >
                {isEdit ? "Save" : "Send invitation"}
              </Button>
            )}
          </Space>
        </div>
      }
    >
      <UserFormBody
        key={formKey}
        user={user}
        roles={roles}
        readOnly={readOnly}
        canGrantSuperAdmin={capabilities.isSuperAdmin && !isSelf}
        busy={busy}
        error={error}
        onDismissError={() => setError(null)}
        onDraftChange={(next) => setDraft({ key: formKey, canSave: next })}
        onSubmit={(values) => {
          void handleSubmit(values);
        }}
        onInvalid={() =>
          setError("Some fields need attention. Check the highlighted ones and try again.")
        }
      />
    </Drawer>
  );
}
