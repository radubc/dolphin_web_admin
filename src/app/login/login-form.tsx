"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, Button, Form, Input, type FormInstance } from "antd";
import { LockOutlined, MailOutlined } from "@ant-design/icons";
import AuthLink from "@/components/auth-link";
import { login, type LoginState } from "./actions";

interface LoginFields {
  email?: string;
  password?: string;
}

/** antd's Form ref: the form instance plus the underlying `<form>` element. */
type LoginFormRef = FormInstance<LoginFields> & { nativeElement?: HTMLElement };

const FIELD_NAMES = ["email", "password"] as const;

const INITIAL_STATE: LoginState = {};

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE);
  // Fields the user has edited since the last submit: their server-side error
  // is stale, so it is hidden until the form is submitted again.
  const [editedFields, setEditedFields] = useState<string[]>([]);
  const formRef = useRef<LoginFormRef>(null);

  /**
   * Copies whatever the browser actually put in the inputs back into antd's
   * store.
   *
   * antd renders these inputs fully controlled (an undefined store value
   * becomes `""`), so a fill React never observes — iCloud Keychain filling
   * before hydration, some extension fills — leaves the store empty. Two things
   * then go wrong: the `required` rules reject a visibly filled field, and the
   * next re-render (`setEditedFields`, the `pending` toggle) pushes `""` back
   * into the DOM and wipes the fill. Reading the DOM and writing it into the
   * store makes the store agree with what the user sees.
   */
  const syncFromDom = useCallback(() => {
    const form = formRef.current;
    const element = form?.nativeElement;
    if (!form || !(element instanceof HTMLFormElement)) {
      return;
    }

    const filled: LoginFields = {};
    for (const name of FIELD_NAMES) {
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
  }, []);

  // Autofill that landed before hydration.
  useEffect(() => {
    syncFromDom();
  }, [syncFromDom]);

  function handleValuesChange(changed: LoginFields) {
    const names = Object.keys(changed);
    setEditedFields((previous) => [
      ...previous,
      ...names.filter((name) => !previous.includes(name)),
    ]);
  }

  // antd's Form always calls preventDefault on submit, so React 19's `action`
  // prop would never fire. Dispatch the Server Action from onFinish instead.
  function handleFinish(values: LoginFields) {
    const element = formRef.current?.nativeElement;
    let formData: FormData;
    if (element instanceof HTMLFormElement) {
      // Built from the live DOM so a late autofill is submitted even if antd's
      // store never saw it.
      formData = new FormData(element);
    } else {
      formData = new FormData();
      formData.set("email", values.email ?? "");
      formData.set("password", values.password ?? "");
    }
    setEditedFields([]);
    startTransition(() => {
      formAction(formData);
    });
  }

  const emailError = editedFields.includes("email")
    ? undefined
    : state.fieldErrors?.email;
  const passwordError = editedFields.includes("password")
    ? undefined
    : state.fieldErrors?.password;

  return (
    <Form<LoginFields>
      ref={formRef}
      layout="vertical"
      method="post"
      requiredMark={false}
      // Capture phase: runs before rc-form's own onSubmit handler, so the store
      // is up to date before validation reads it.
      onSubmitCapture={syncFromDom}
      onFinish={handleFinish}
      onValuesChange={handleValuesChange}
      disabled={pending}
      size="large"
    >
      {state.error ? (
        <Alert
          type="error"
          showIcon
          title={state.error}
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

      <Form.Item
        name="password"
        label="Password"
        htmlFor="password"
        validateStatus={passwordError ? "error" : undefined}
        help={passwordError}
        rules={[{ required: true, message: "Enter your password." }]}
      >
        <Input.Password
          id="password"
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          prefix={<LockOutlined aria-hidden />}
        />
      </Form.Item>

      <div className="-mt-2 mb-1 flex justify-end">
        <AuthLink href="/forgot-password">Forgot password?</AuthLink>
      </div>

      <Form.Item style={{ marginBottom: 0, marginTop: 24 }}>
        <Button type="primary" htmlType="submit" block loading={pending}>
          Sign in
        </Button>
      </Form.Item>
    </Form>
  );
}
