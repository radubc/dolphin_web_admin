"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Steps,
  type FormInstance,
} from "antd";
import { LockOutlined, MailOutlined, NumberOutlined } from "@ant-design/icons";
import AuthLink from "@/components/auth-link";
import {
  confirmPasswordReset,
  requestPasswordReset,
  type ConfirmResetState,
  type RequestResetState,
} from "./actions";

interface EmailFields {
  email?: string;
}

interface ResetFields {
  code?: string;
  password?: string;
  confirm?: string;
}

/** antd's Form ref: the form instance plus the underlying `<form>` element. */
type AntdFormRef<T> = FormInstance<T> & { nativeElement?: HTMLElement };

const EMAIL_FIELDS = ["email"] as const;
const RESET_FIELDS = ["code", "password", "confirm"] as const;

const INITIAL_REQUEST_STATE: RequestResetState = {};
const INITIAL_CONFIRM_STATE: ConfirmResetState = {};

const EMAIL_STEP = 0;
const PASSWORD_STEP = 1;

/**
 * The slice of antd's `FormInstance` the DOM sync needs. Its real methods are
 * keyed to the form's field-name union, which cannot express the plain string
 * names this walks, so the sync works against this loose view instead.
 */
interface DomSyncForm {
  nativeElement?: HTMLElement;
  getFieldValue(name: string): unknown;
  setFieldsValue(values: Record<string, string>): void;
}

/**
 * Copies whatever the browser actually put in the inputs back into antd's
 * store.
 *
 * Same problem the login form solves: antd renders these inputs fully
 * controlled (an undefined store value becomes `""`), so a fill React never
 * observes — iCloud Keychain filling before hydration, a password manager
 * generating a new password — leaves the store empty. The `required` rules
 * then reject a visibly filled field, and the next re-render pushes `""` back
 * into the DOM and wipes the fill.
 */
function useSyncFromDom(
  formRef: RefObject<{ nativeElement?: HTMLElement } | null>,
  fieldNames: readonly string[],
) {
  return useCallback(() => {
    const form = formRef.current as DomSyncForm | null;
    const element = form?.nativeElement;
    if (!form || !(element instanceof HTMLFormElement)) {
      return;
    }

    const filled: Record<string, string> = {};
    for (const name of fieldNames) {
      const input = element.elements.namedItem(name);
      if (!(input instanceof HTMLInputElement)) {
        continue;
      }
      // Only adopt a non-empty DOM value: an empty input never carries
      // information the store does not already have, and writing it back would
      // clobber a value the user typed.
      if (input.value !== "" && input.value !== form.getFieldValue(name)) {
        filled[name] = input.value;
      }
    }

    if (Object.keys(filled).length > 0) {
      form.setFieldsValue(filled);
    }
  }, [formRef, fieldNames]);
}

/** Names of fields edited since the last submit, whose server error is stale. */
function useEditedFields() {
  const [editedFields, setEditedFields] = useState<string[]>([]);
  const handleValuesChange = useCallback((changed: object) => {
    const names = Object.keys(changed);
    setEditedFields((previous) => [
      ...previous,
      ...names.filter((name) => !previous.includes(name)),
    ]);
  }, []);
  const clear = useCallback(() => setEditedFields([]), []);
  return { editedFields, handleValuesChange, clear };
}

/** Builds the payload from the live DOM so a late autofill is still submitted. */
function formDataFrom(
  element: HTMLElement | undefined,
  fallback: Record<string, string>,
): FormData {
  if (element instanceof HTMLFormElement) {
    return new FormData(element);
  }
  const formData = new FormData();
  for (const [name, value] of Object.entries(fallback)) {
    formData.set(name, value);
  }
  return formData;
}

export default function ForgotPasswordForm() {
  const [requestState, requestAction, requestPending] = useActionState(
    requestPasswordReset,
    INITIAL_REQUEST_STATE,
  );
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmPasswordReset,
    INITIAL_CONFIRM_STATE,
  );

  // Which step to show is derived, not stored: the step is whatever the latest
  // step-one result says, unless the user has asked to go back from it.
  // `useActionState` hands back a fresh object per dispatch, so identity is
  // enough to tell "the result I walked away from" from "a newer result", and
  // the form stays put while a resend is still in flight.
  const [dismissedRequest, setDismissedRequest] =
    useState<RequestResetState | null>(null);
  // Same idea for stale code/password errors: `useActionState` has no reset.
  const [dismissedConfirm, setDismissedConfirm] =
    useState<ConfirmResetState | null>(null);

  const step =
    requestState.sent && requestState !== dismissedRequest
      ? PASSWORD_STEP
      : EMAIL_STEP;
  const email = requestState.email ?? "";
  const showConfirmFeedback = confirmState !== dismissedConfirm;

  const emailFormRef = useRef<AntdFormRef<EmailFields>>(null);
  const resetFormRef = useRef<AntdFormRef<ResetFields>>(null);
  const syncEmailFromDom = useSyncFromDom(emailFormRef, EMAIL_FIELDS);
  const syncResetFromDom = useSyncFromDom(resetFormRef, RESET_FIELDS);

  const emailEdits = useEditedFields();
  const resetEdits = useEditedFields();

  // Autofill that landed before hydration.
  useEffect(() => {
    syncEmailFromDom();
  }, [syncEmailFromDom]);

  // antd's Form always calls preventDefault on submit, so React 19's `action`
  // prop would never fire. Dispatch the Server Action from onFinish instead.
  function handleRequestFinish(values: EmailFields) {
    const formData = formDataFrom(emailFormRef.current?.nativeElement, {
      email: values.email ?? "",
    });
    emailEdits.clear();
    startTransition(() => {
      requestAction(formData);
    });
  }

  function handleConfirmFinish(values: ResetFields) {
    const formData = formDataFrom(resetFormRef.current?.nativeElement, {
      email,
      code: values.code ?? "",
      password: values.password ?? "",
      confirm: values.confirm ?? "",
    });
    // The hidden input is inside the form, but a fallback payload would miss
    // it; either way the server re-validates the address.
    formData.set("email", email);
    resetEdits.clear();
    startTransition(() => {
      confirmAction(formData);
    });
  }

  function backToEmailStep() {
    setDismissedConfirm(confirmState);
    setDismissedRequest(requestState);
    // Drop the half-finished code and password rather than carry them into the
    // next visit to step two. The `key` on each Form already forces a remount,
    // but resetting explicitly also empties the inputs currently on screen, so
    // nothing stale is left for the browser or a password manager to re-read.
    resetFormRef.current?.resetFields();
    // Edit tracking is about "touched since the last submit". Both forms are
    // about to be rebuilt from scratch, so neither set of keystrokes should
    // still count against the errors of whatever is submitted next.
    resetEdits.clear();
    emailEdits.clear();
  }

  const pending = requestPending || confirmPending;

  const emailError = emailEdits.editedFields.includes("email")
    ? undefined
    : requestState.fieldErrors?.email;

  // The server says this code can never work: make the way to a fresh one the
  // prominent action rather than a quiet link.
  const needsNewCode = showConfirmFeedback && confirmState.allowResend === true;

  const confirmFieldError = (name: keyof ResetFields) =>
    !showConfirmFeedback || resetEdits.editedFields.includes(name)
      ? undefined
      : confirmState.fieldErrors?.[name];

  return (
    <>
      <Steps
        size="small"
        current={step}
        items={[{ title: "Email" }, { title: "New password" }]}
        style={{ marginBottom: 24 }}
      />

      {/*
        The two branches render a Form at the same position in the tree, so
        without distinct keys React reconciles them as one component and rc-form
        keeps a single store: `initialValues` would only apply on the very first
        mount and step two's values would survive a trip back to step one
        (`preserve` defaults to true). The keys force a real remount each way.
      */}
      {step === EMAIL_STEP ? (
        <Form<EmailFields>
          key="request"
          ref={emailFormRef}
          layout="vertical"
          method="post"
          requiredMark={false}
          initialValues={{ email }}
          // Capture phase: runs before rc-form's own onSubmit handler, so the
          // store is up to date before validation reads it.
          onSubmitCapture={syncEmailFromDom}
          onFinish={handleRequestFinish}
          onValuesChange={emailEdits.handleValuesChange}
          disabled={pending}
          size="large"
        >
          {requestState.error ? (
            <Alert
              type="error"
              showIcon
              title={requestState.error}
              role="alert"
              style={{ marginBottom: 20 }}
            />
          ) : null}

          <Form.Item
            name="email"
            label="Email"
            htmlFor="email"
            validateStatus={emailError ? "error" : undefined}
            help={emailError}
            rules={[
              { required: true, message: "Enter your email address." },
              { type: "email", message: "Enter a valid email address." },
            ]}
          >
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder="you@example.com"
              prefix={<MailOutlined aria-hidden />}
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0, marginTop: 24 }}>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={requestPending}
            >
              Send code
            </Button>
          </Form.Item>
        </Form>
      ) : (
        <Form<ResetFields>
          key="confirm"
          ref={resetFormRef}
          layout="vertical"
          method="post"
          requiredMark={false}
          onSubmitCapture={syncResetFromDom}
          onFinish={handleConfirmFinish}
          onValuesChange={resetEdits.handleValuesChange}
          disabled={pending}
          size="large"
        >
          {/*
            Carries the address to the server and gives password managers the
            username that goes with the new password they are about to save.

            Hidden with Tailwind's `sr-only` (absolutely positioned, 1px,
            clipped) rather than `type="hidden"` or `display: none`: password
            managers ignore both of those when looking for the username that
            pairs with a `new-password` field, but they do read a laid-out
            input. Used here purely for the visual hiding — the field is
            `aria-hidden` and unfocusable, because the user already typed this
            address in step one and it is shown back to them in step one's form.
          */}
          <input
            className="sr-only"
            type="email"
            name="email"
            value={email}
            autoComplete="username"
            readOnly
            tabIndex={-1}
            aria-hidden
          />

          {/*
            Always the same wording. Naming the address Cognito delivered to
            would only be possible when the account exists, which is the leak
            this flow exists to avoid.
          */}
          {requestState.message ? (
            <Alert
              type="success"
              showIcon
              title={requestState.message}
              description="It may take a minute to arrive. Check your spam folder too."
              role="status"
              style={{ marginBottom: 20 }}
            />
          ) : null}

          {showConfirmFeedback && confirmState.error ? (
            <Alert
              type="error"
              showIcon
              title={confirmState.error}
              role="alert"
              style={{ marginBottom: 20 }}
            />
          ) : null}

          <Form.Item
            name="code"
            label="Verification code"
            htmlFor="code"
            validateStatus={confirmFieldError("code") ? "error" : undefined}
            help={confirmFieldError("code")}
            rules={[
              { required: true, message: "Enter the code from the email." },
            ]}
          >
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              maxLength={64}
              placeholder="123456"
              prefix={<NumberOutlined aria-hidden />}
            />
          </Form.Item>

          <Form.Item
            name="password"
            label="New password"
            htmlFor="password"
            validateStatus={confirmFieldError("password") ? "error" : undefined}
            help={confirmFieldError("password")}
            rules={[{ required: true, message: "Enter a new password." }]}
          >
            <Input.Password
              id="password"
              name="password"
              autoComplete="new-password"
              placeholder="Your new password"
              prefix={<LockOutlined aria-hidden />}
            />
          </Form.Item>

          <Form.Item
            name="confirm"
            label="Confirm new password"
            htmlFor="confirm"
            dependencies={["password"]}
            validateStatus={confirmFieldError("confirm") ? "error" : undefined}
            help={confirmFieldError("confirm")}
            rules={[
              { required: true, message: "Re-enter the new password." },
              ({ getFieldValue }) => ({
                validator(_rule, value: string | undefined) {
                  if (!value || getFieldValue("password") === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error("Both passwords must match."));
                },
              }),
            ]}
          >
            <Input.Password
              id="confirm"
              name="confirm"
              autoComplete="new-password"
              placeholder="Repeat the new password"
              prefix={<LockOutlined aria-hidden />}
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0, marginTop: 24 }}>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={confirmPending}
            >
              Reset password
            </Button>
          </Form.Item>
        </Form>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <AuthLink href="/login">Back to sign in</AuthLink>
        {step === PASSWORD_STEP ? (
          <Button
            type={needsNewCode ? "primary" : "link"}
            size="small"
            style={needsNewCode ? undefined : { paddingInline: 0 }}
            disabled={pending}
            onClick={backToEmailStep}
          >
            Send a new code
          </Button>
        ) : null}
      </div>
    </>
  );
}
