"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Alert, Button, Divider, Form, Input, type FormInstance } from "antd";
import {
  KeyOutlined,
  LockOutlined,
  MailOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import AuthLink from "@/components/auth-link";
import {
  FormErrorSummary,
  useFormErrorSummary,
  type FormValidationFailure,
} from "@/components/form-error-summary";
import {
  getPasskeyAssertion,
  passkeySignInSupported,
} from "@/lib/account/webauthn";
import {
  isSilentAttribute,
  localeFromBrowser,
  MAX_ATTRIBUTE_LENGTH,
  requiredAttributeSpecs,
  validateAttributeValue,
  type RequiredAttributeSpec,
} from "@/lib/auth/required-attributes";
import {
  completeInvitation,
  completePasskeySignIn,
  login,
  startPasskeySignIn,
  verifyMfaCode,
  type CompleteInvitationState,
  type LoginState,
  type MfaState,
  type PasskeyState,
} from "./actions";

interface LoginFields {
  email?: string;
  password?: string;
}

/**
 * The two password inputs, plus one entry per attribute the pool requires,
 * keyed by form field name (`attr_given_name`). The index signature is what
 * lets rc-form hold names that only exist at runtime.
 */
interface NewPasswordFields {
  password?: string;
  confirm?: string;
  [field: string]: string | undefined;
}

interface MfaFields {
  code?: string;
}

/** antd's Form ref: the form instance plus the underlying `<form>` element. */
type AntdFormRef<T> = FormInstance<T> & { nativeElement?: HTMLElement };

const LOGIN_FIELDS = ["email", "password"] as const;
const NEW_PASSWORD_FIELDS = ["password", "confirm"] as const;
const MFA_FIELDS = ["code"] as const;

/** Six digits, tolerating the space or dash an app may show them with. */
const TOTP_INPUT_PATTERN = /^\s*\d{3}\s?-?\s?\d{3}\s*$/;

/**
 * DOM id for an attribute input. The form field keeps the real name
 * (`attr_custom:team`, which is what the action reads); the id drops the colon
 * a custom attribute brings with it, since an id with a colon is invalid in a
 * CSS selector and antd derives one from the field name when not told
 * otherwise.
 */
function inputIdFor(spec: RequiredAttributeSpec): string {
  return spec.field.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** The HTML input type that suits an attribute. */
function inputTypeFor(spec: RequiredAttributeSpec): string {
  switch (spec.kind) {
    case "phone":
      return "tel";
    case "date":
      // Native pickers hand back exactly the YYYY-MM-DD Cognito wants; a
      // browser without one falls back to a text box, which the same rule
      // still validates.
      return "date";
    default:
      return "text";
  }
}

const INITIAL_LOGIN_STATE: LoginState = {};
const INITIAL_INVITATION_STATE: CompleteInvitationState = {};
const INITIAL_MFA_STATE: MfaState = {};
const INITIAL_PASSKEY_STATE: PasskeyState = {};

/** No-op subscribe: whether WebAuthn exists never changes within a page. */
const NEVER_CHANGES = () => () => {};

/**
 * Server snapshot for the passkey button: assume support, so the button is in
 * the HTML rather than popping in after hydration. A browser without WebAuthn
 * drops it on the client's first pass.
 */
const ALWAYS_SUPPORTED_ON_SERVER = () => true;

/**
 * What the browser throws when the person dismisses the system sheet, or when
 * it aborts the ceremony itself. Not an error: nothing is sent and the form is
 * left exactly as it was.
 */
function wasCancelled(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

/**
 * The browser's own words for a WebAuthn failure this app cannot explain —
 * on `localhost`, where the host is not the pool's relying party id, that is a
 * `SecurityError` from the browser and never a Cognito message.
 */
const PASSKEY_BROWSER_ERROR =
  "Your browser could not use a passkey for this site.";

function passkeyErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? `${PASSKEY_BROWSER_ERROR} ${error.message}`
    : PASSKEY_BROWSER_ERROR;
}

/** Mirrors MIN_PASSWORD_LENGTH on the server; Cognito owns the real policy. */
const MIN_PASSWORD_LENGTH = 8;

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
 * antd renders these inputs fully controlled (an undefined store value becomes
 * `""`), so a fill React never observes — iCloud Keychain filling before
 * hydration, a password manager generating a new password, an authenticator
 * pasting a one-time code — leaves the store empty. Two things then go wrong:
 * the `required` rules reject a visibly filled field, and the next re-render
 * (`setEditedFields`, the `pending` toggle) pushes `""` back into the DOM and
 * wipes the fill. Reading the DOM and writing it into the store makes the
 * store agree with what the user sees.
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

/**
 * Sign-in, in up to two steps.
 *
 * Step one is always email and password. Cognito then decides what comes next:
 *
 * - a session, and the action redirects;
 * - **NEW_PASSWORD_REQUIRED** — the operator was invited with a temporary
 *   password, so step two collects their own (plus any profile attribute the
 *   pool insists on) and finishes the sign-in;
 * - **SOFTWARE_TOKEN_MFA** — the operator has an authenticator app, so step
 *   two is the six-digit code.
 *
 * Both second steps carry Cognito's opaque continuation token in a hidden
 * field, offer "Start over", and fall back to step one with an explanation
 * when that token expires.
 *
 * Step one also offers a **passkey**, which is a different shape: two Server
 * Action calls with the browser's authenticator prompt between them, and no
 * second step on screen. It uses the email that is already typed, and every
 * outcome — including "that address has no passkey" — is reported in step one's
 * own alert. The button is not rendered at all by a browser without WebAuthn.
 */
export default function LoginForm() {
  const [loginState, loginAction, loginPending] = useActionState(
    login,
    INITIAL_LOGIN_STATE,
  );
  const [invitationState, invitationAction, invitationPending] = useActionState(
    completeInvitation,
    INITIAL_INVITATION_STATE,
  );
  const [mfaState, mfaAction, mfaPending] = useActionState(
    verifyMfaCode,
    INITIAL_MFA_STATE,
  );
  // The passkey assertion is dispatched like the other steps, so that Cognito's
  // tokens and the action's `redirect("/")` are handled exactly as they are on
  // the password path. Only *starting* the ceremony is a direct call.
  const [passkeyState, passkeyAction, passkeyPending] = useActionState(
    completePasskeySignIn,
    INITIAL_PASSKEY_STATE,
  );

  // Which step to show is derived, not stored: step two is on whenever the
  // latest sign-in produced a challenge the user has not walked away from.
  // `useActionState` hands back a fresh object per dispatch, so identity is
  // enough to tell "the challenge I dismissed" from "a newer one", and it has
  // no reset of its own. Only the step reads this — the sign-in error and its
  // field messages still come straight off the latest result, unchanged.
  const [dismissedChallenge, setDismissedChallenge] =
    useState<LoginState | null>(null);
  const [dismissedInvitation, setDismissedInvitation] =
    useState<CompleteInvitationState | null>(null);
  const [dismissedMfa, setDismissedMfa] = useState<MfaState | null>(null);
  const [dismissedPasskey, setDismissedPasskey] = useState<PasskeyState | null>(
    null,
  );

  const showInvitationFeedback = invitationState !== dismissedInvitation;
  const showMfaFeedback = mfaState !== dismissedMfa;

  /**
   * Whether the message under step one belongs to the password attempt or to
   * the passkey one. The two share the alert, and without this the older of the
   * two would keep the slot: `useActionState` has no reset, so a failed password
   * attempt's error outlives it.
   */
  const [lastAttempt, setLastAttempt] = useState<"password" | "passkey">(
    "password",
  );
  /** Everything that goes wrong before the assertion reaches the server. */
  const [passkeyError, setPasskeyError] = useState<string | undefined>(
    undefined,
  );
  /** True from the click until the assertion is dispatched (or abandoned). */
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  // Cognito retired the challenge session: back to email and password, with
  // the reason shown there.
  const expiredMessage =
    showInvitationFeedback && invitationState.restart === true
      ? invitationState.error
      : showMfaFeedback && mfaState.restart === true
        ? mfaState.error
        : undefined;

  const liveLogin =
    loginState !== dismissedChallenge && !expiredMessage
      ? loginState
      : undefined;
  const challenge = liveLogin?.challenge;
  // Cognito never raises both at once; the guard keeps the render unambiguous.
  const mfa = challenge ? undefined : liveLogin?.mfa;

  // What the pool wants alongside the new password. Empty for a pool that
  // requires nothing beyond `email`, which is the common case.
  const attributeSpecs = useMemo(
    () => requiredAttributeSpecs(challenge?.requiredAttributes ?? []),
    [challenge],
  );

  const loginFormRef = useRef<AntdFormRef<LoginFields>>(null);
  const passwordFormRef = useRef<AntdFormRef<NewPasswordFields>>(null);
  const mfaFormRef = useRef<AntdFormRef<MfaFields>>(null);
  const syncLoginFromDom = useSyncFromDom(loginFormRef, LOGIN_FIELDS);
  // The attribute inputs are autofill targets too (a browser will happily fill
  // a name or a phone number), so they need the same DOM-to-store sync.
  const newPasswordFields = useMemo(
    () => [...NEW_PASSWORD_FIELDS, ...attributeSpecs.map((spec) => spec.field)],
    [attributeSpecs],
  );
  const syncPasswordFromDom = useSyncFromDom(
    passwordFormRef,
    newPasswordFields,
  );
  // iOS and Safari fill a one-time code straight into the DOM.
  const syncMfaFromDom = useSyncFromDom(mfaFormRef, MFA_FIELDS);

  const loginEdits = useEditedFields();
  const passwordEdits = useEditedFields();
  const mfaEdits = useEditedFields();

  // One summary per step: the three forms are alternatives, but each keeps its
  // own list of what was left empty rather than inheriting the last one's.
  const loginSummary = useFormErrorSummary();
  const passwordSummary = useFormErrorSummary();
  const mfaSummary = useFormErrorSummary();

  /**
   * Whether this browser can use a passkey at all.
   *
   * `useSyncExternalStore` rather than an effect: `navigator.credentials` does
   * not exist on the server, so the server snapshot is an optimistic `true` and
   * the real answer arrives on the client's first pass — no hydration mismatch,
   * and no `setState` in an effect. Nothing ever changes the value, hence the
   * no-op subscribe. Same pattern as the Account & security drawer.
   */
  const passkeysUsable = useSyncExternalStore(
    NEVER_CHANGES,
    passkeySignInSupported,
    ALWAYS_SUPPORTED_ON_SERVER,
  );

  // Autofill that landed before hydration.
  useEffect(() => {
    syncLoginFromDom();
  }, [syncLoginFromDom]);

  // antd's Form always calls preventDefault on submit, so React 19's `action`
  // prop would never fire. Dispatch the Server Action from onFinish instead.
  function handleLoginFinish(values: LoginFields) {
    const formData = formDataFrom(loginFormRef.current?.nativeElement, {
      email: values.email ?? "",
      password: values.password ?? "",
    });
    // A new attempt supersedes the earlier results: the expiry notice that
    // would otherwise keep hiding step two, and the challenge this attempt is
    // about to replace — without the latter, clearing the notice would flip
    // the form to step two with the *previous* (dead) session while the
    // request is still in flight.
    setDismissedInvitation(invitationState);
    setDismissedMfa(mfaState);
    setDismissedChallenge(loginState);
    setDismissedPasskey(passkeyState);
    setPasskeyError(undefined);
    setLastAttempt("password");
    loginEdits.clear();
    loginSummary.reset();
    startTransition(() => {
      loginAction(formData);
    });
  }

  /**
   * The passkey route, start to finish: ask Cognito for a challenge, run the
   * authenticator, post the assertion back.
   *
   * Only the email is validated — the password field is not part of this path,
   * so its `required` rule must not fire. A dismissed prompt sends nothing and
   * says nothing; anything else lands in step one's alert.
   */
  async function signInWithPasskey() {
    setDismissedPasskey(passkeyState);
    setPasskeyError(undefined);
    setLastAttempt("passkey");
    loginSummary.reset();
    // A password manager may have filled the address without React seeing it.
    syncLoginFromDom();

    let email: string;
    try {
      const values = await loginFormRef.current?.validateFields(["email"]);
      email = (values?.email ?? "").trim();
    } catch (invalid) {
      // The same summary a failed submit produces: "Email is required".
      loginSummary.onFinishFailed(invalid as FormValidationFailure);
      return;
    }

    setPasskeyBusy(true);
    try {
      const started = await startPasskeySignIn(email);
      if (!started.ok) {
        setPasskeyError(started.error);
        return;
      }

      // Throws `NotAllowedError` if the person dismisses the system prompt.
      const credential = await getPasskeyAssertion(started.options);

      const formData = new FormData();
      formData.set("email", email);
      formData.set("username", started.username);
      // Cognito's continuation token travels in the action's payload, never in
      // the URL: out of history, logs and referrers, exactly like the hidden
      // field the other two steps use. Nothing writes it into the DOM.
      formData.set("challengeSession", started.session);
      formData.set("credential", JSON.stringify(credential));
      startTransition(() => {
        passkeyAction(formData);
      });
    } catch (cause) {
      if (!wasCancelled(cause)) {
        setPasskeyError(passkeyErrorMessage(cause));
      }
    } finally {
      setPasskeyBusy(false);
    }
  }

  function handlePasswordFinish(values: NewPasswordFields) {
    const fallback: Record<string, string> = {
      password: values.password ?? "",
      confirm: values.confirm ?? "",
    };
    for (const spec of attributeSpecs) {
      fallback[spec.field] = values[spec.field] ?? "";
    }
    const formData = formDataFrom(
      passwordFormRef.current?.nativeElement,
      fallback,
    );
    // Attributes the step fills in itself: `locale` is the browser's language,
    // read here at submit time so nothing about it is rendered or stored.
    for (const spec of attributeSpecs) {
      if (isSilentAttribute(spec)) {
        formData.set(spec.field, localeFromBrowser(navigator.language));
      }
    }
    // The hidden inputs are inside the form, but a fallback payload would miss
    // them; either way the server re-validates everything it receives.
    formData.set("email", challenge?.email ?? "");
    formData.set("username", challenge?.username ?? "");
    formData.set("challengeSession", challenge?.session ?? "");
    // Tells the action which inputs to read. It re-checks every name against
    // the same allowlist, so this is a hint, not a permission.
    formData.set(
      "attribute_names",
      attributeSpecs.map((spec) => spec.name).join(","),
    );
    passwordEdits.clear();
    passwordSummary.reset();
    startTransition(() => {
      invitationAction(formData);
    });
  }

  function handleMfaFinish(values: MfaFields) {
    const formData = formDataFrom(mfaFormRef.current?.nativeElement, {
      code: values.code ?? "",
    });
    formData.set("email", mfa?.email ?? "");
    formData.set("username", mfa?.username ?? "");
    formData.set("challengeSession", mfa?.session ?? "");
    mfaEdits.clear();
    mfaSummary.reset();
    startTransition(() => {
      mfaAction(formData);
    });
  }

  function startOver() {
    setDismissedChallenge(loginState);
    setDismissedInvitation(invitationState);
    setDismissedMfa(mfaState);
    // Drop the half-typed secrets rather than carry them into the next visit.
    // The `key` on each Form already forces a remount, but resetting
    // explicitly also empties the inputs currently on screen, so nothing stale
    // is left for the browser or a password manager to re-read.
    passwordFormRef.current?.resetFields();
    mfaFormRef.current?.resetFields();
    passwordEdits.clear();
    mfaEdits.clear();
    loginEdits.clear();
    loginSummary.reset();
    passwordSummary.reset();
    mfaSummary.reset();
    setDismissedPasskey(passkeyState);
    setPasskeyError(undefined);
    setLastAttempt("password");
  }

  const pending =
    loginPending ||
    invitationPending ||
    mfaPending ||
    passkeyPending ||
    passkeyBusy;

  const emailError = loginEdits.editedFields.includes("email")
    ? undefined
    : loginState.fieldErrors?.email;
  const passwordError = loginEdits.editedFields.includes("password")
    ? undefined
    : loginState.fieldErrors?.password;

  const invitationFieldError = (name: "password" | "confirm") =>
    !showInvitationFeedback || passwordEdits.editedFields.includes(name)
      ? undefined
      : invitationState.fieldErrors?.[name];

  // Attribute errors are keyed by Cognito attribute name on the server and by
  // form field name in the edit tracker, hence the two names here.
  const attributeError = (spec: RequiredAttributeSpec) =>
    !showInvitationFeedback || passwordEdits.editedFields.includes(spec.field)
      ? undefined
      : invitationState.fieldErrors?.attributes?.[spec.name];

  const mfaCodeError =
    !showMfaFeedback || mfaEdits.editedFields.includes("code")
      ? undefined
      : mfaState.fieldErrors?.code;

  // Whatever the passkey route came to, from either of its two calls.
  const passkeyMessage =
    passkeyError ??
    (passkeyState !== dismissedPasskey ? passkeyState.error : undefined);

  // The expiry notice wins: it is the newer of the two, and a sign-in that
  // produced a challenge never carries an error of its own anyway. Below it,
  // the alert belongs to whichever route was tried last.
  const stepOneAlert =
    expiredMessage ??
    (lastAttempt === "passkey" ? passkeyMessage : loginState.error);

  if (challenge === undefined && mfa === undefined) {
    return (
      <Form<LoginFields>
        key="login"
        ref={loginFormRef}
        layout="vertical"
        method="post"
        // Capture phase: runs before rc-form's own onSubmit handler, so the
        // store is up to date before validation reads it.
        onSubmitCapture={syncLoginFromDom}
        onFinish={handleLoginFinish}
        onFinishFailed={loginSummary.onFinishFailed}
        onValuesChange={loginEdits.handleValuesChange}
        disabled={pending}
        size="large"
      >
        <FormErrorSummary
          summary={loginSummary.errorSummary}
          onClose={loginSummary.reset}
          style={{ marginBottom: 20 }}
        />

        {stepOneAlert ? (
          <Alert
            type="error"
            showIcon
            title={stepOneAlert}
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
            { required: true },
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
          rules={[{ required: true }]}
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
          <Button type="primary" htmlType="submit" block loading={loginPending}>
            Sign in
          </Button>
        </Form.Item>

        {/*
          The passkey route. Hidden outright when the browser has no WebAuthn:
          there is nothing the button could do there, and an explanation would
          only be noise on a sign-in page that still works with a password.
        */}
        {passkeysUsable ? (
          <>
            <Divider plain style={{ marginBlock: 20 }}>
              or
            </Divider>
            <Button
              // Never `submit`: this path does not go through the form's
              // validation, which would demand the password as well.
              htmlType="button"
              block
              icon={<KeyOutlined aria-hidden />}
              loading={passkeyBusy || passkeyPending}
              onClick={() => {
                void signInWithPasskey();
              }}
            >
              Sign in with a passkey
            </Button>
          </>
        ) : null}
      </Form>
    );
  }

  if (mfa !== undefined) {
    return (
      <>
        <Form<MfaFields>
          key="mfa"
          ref={mfaFormRef}
          layout="vertical"
          method="post"
          onSubmitCapture={syncMfaFromDom}
          onFinish={handleMfaFinish}
          onFinishFailed={mfaSummary.onFinishFailed}
          onValuesChange={mfaEdits.handleValuesChange}
          disabled={pending}
          size="large"
        >
          {/*
            Cognito's continuation token and the pool username it expects back.
            Both are opaque to the browser, and the server treats them as
            untrusted input; the token is short-lived and single-use, which is
            why it travels in the form body rather than in the URL.
          */}
          <input type="hidden" name="challengeSession" value={mfa.session} />
          <input type="hidden" name="username" value={mfa.username} />
          <input type="hidden" name="email" value={mfa.email} />

          <FormErrorSummary
            summary={mfaSummary.errorSummary}
            onClose={mfaSummary.reset}
            style={{ marginBottom: 20 }}
          />

          <Alert
            type="info"
            showIcon
            title="Enter the six-digit code from your authenticator app to finish signing in."
            role="status"
            style={{ marginBottom: 20 }}
          />

          {showMfaFeedback && mfaState.error ? (
            <Alert
              type="error"
              showIcon
              title={mfaState.error}
              role="alert"
              style={{ marginBottom: 20 }}
            />
          ) : null}

          <Form.Item
            name="code"
            label="Verification code"
            htmlFor="mfa-code"
            validateStatus={mfaCodeError ? "error" : undefined}
            help={mfaCodeError}
            rules={[
              { required: true },
              {
                pattern: TOTP_INPUT_PATTERN,
                message: "Enter the six digits from your app.",
              },
            ]}
          >
            <Input
              id="mfa-code"
              name="code"
              // `one-time-code` is what makes iOS and Safari offer the code
              // the authenticator just generated.
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              maxLength={7}
              placeholder="123456"
              prefix={<SafetyOutlined aria-hidden />}
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0, marginTop: 24 }}>
            <Button type="primary" htmlType="submit" block loading={mfaPending}>
              Verify and sign in
            </Button>
          </Form.Item>
        </Form>

        <div className="mt-4 flex justify-end">
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            disabled={pending}
            onClick={startOver}
          >
            Start over
          </Button>
        </div>
      </>
    );
  }

  // Narrowing only: the first branch returned when both were undefined and the
  // second when `mfa` was set, so `challenge` is defined from here on.
  if (challenge === undefined) {
    return null;
  }

  return (
    <>
      {/*
        A distinct key from the sign-in form: without it React would reconcile
        the two as one component and rc-form would keep a single store, so the
        temporary password typed on step one would still be in it here.
      */}
      <Form<NewPasswordFields>
        key="new-password"
        ref={passwordFormRef}
        layout="vertical"
        method="post"
        onSubmitCapture={syncPasswordFromDom}
        onFinish={handlePasswordFinish}
        onFinishFailed={passwordSummary.onFinishFailed}
        onValuesChange={passwordEdits.handleValuesChange}
        disabled={pending}
        size="large"
      >
        {/*
          Cognito's continuation token and the pool username it expects back.
          Both are opaque to the browser, and the server treats them as
          untrusted input; the token is short-lived and single-use, which is
          why it travels in the form body rather than in the URL.
        */}
        <input
          type="hidden"
          name="challengeSession"
          value={challenge.session}
        />
        <input type="hidden" name="username" value={challenge.username} />
        {/*
          Which attributes the pool asked for. The action reads it to know
          which inputs to look at, and re-checks every name against the
          allowlist before it forwards anything to Cognito.
        */}
        <input
          type="hidden"
          name="attribute_names"
          value={attributeSpecs.map((spec) => spec.name).join(",")}
        />

        <FormErrorSummary
          summary={passwordSummary.errorSummary}
          onClose={passwordSummary.reset}
          style={{ marginBottom: 20 }}
        />

        <Alert
          type="info"
          showIcon
          title={
            attributeSpecs.some((spec) => !isSilentAttribute(spec))
              ? "You signed in with a temporary password. Tell us a little about yourself and choose your own password to finish setting up your account."
              : "You signed in with a temporary password. Choose your own to finish setting up your account."
          }
          role="status"
          style={{ marginBottom: 20 }}
        />

        {showInvitationFeedback && invitationState.error ? (
          <Alert
            type="error"
            showIcon
            title={invitationState.error}
            role="alert"
            style={{ marginBottom: 20 }}
          />
        ) : null}

        {/*
          Read-only, and still a real submitted input: it carries the address
          to the server and gives password managers the username that pairs
          with the new password they are about to save.
        */}
        <Form.Item label="Email" htmlFor="invited-email">
          <Input
            id="invited-email"
            name="email"
            type="email"
            value={challenge.email}
            autoComplete="username"
            readOnly
            prefix={<MailOutlined aria-hidden />}
          />
        </Form.Item>

        {/*
          One input per attribute the pool requires and the person has to type,
          above the passwords: they are what the sentence above just asked for,
          and a password manager should see the new-password pair last and
          adjacent. Attributes the step fills in itself (`isSilentAttribute`)
          have no input at all; `handlePasswordFinish` adds them to the payload.
        */}
        {attributeSpecs
          .filter((spec) => !isSilentAttribute(spec))
          .map((spec, index) => {
            const error = attributeError(spec);
            return (
              <Form.Item
                key={spec.field}
                name={spec.field}
                label={spec.label}
                htmlFor={inputIdFor(spec)}
                extra={spec.hint}
                validateStatus={error ? "error" : undefined}
                help={error}
                rules={[
                  { required: true, whitespace: true },
                  {
                    validator(_rule, value: string | undefined) {
                      // Empty is the required rule's business, not this one's.
                      if (value === undefined || value.trim() === "") {
                        return Promise.resolve();
                      }
                      // The very same check the Server Action runs, so the two
                      // can never disagree about what is acceptable.
                      const { error: message } = validateAttributeValue(
                        spec,
                        value,
                      );
                      return message
                        ? Promise.reject(new Error(message))
                        : Promise.resolve();
                    },
                  },
                ]}
              >
                <Input
                  id={inputIdFor(spec)}
                  name={spec.field}
                  type={inputTypeFor(spec)}
                  autoComplete={spec.autoComplete ?? "off"}
                  placeholder={spec.placeholder}
                  // Cognito's own ceiling for a string attribute; the server
                  // rejects anything longer anyway.
                  maxLength={MAX_ATTRIBUTE_LENGTH}
                  autoFocus={index === 0}
                />
              </Form.Item>
            );
          })}

        <Form.Item
          name="password"
          label="New password"
          htmlFor="new-password"
          validateStatus={invitationFieldError("password") ? "error" : undefined}
          help={invitationFieldError("password")}
          // Length only: the pool's complexity policy is Cognito's to enforce,
          // and its message is what gets shown if the password falls short.
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
            name="password"
            autoComplete="new-password"
            // The first attribute input takes the focus when there is one.
            autoFocus={!attributeSpecs.some((spec) => !isSilentAttribute(spec))}
            placeholder="Your new password"
            prefix={<LockOutlined aria-hidden />}
          />
        </Form.Item>

        <Form.Item
          name="confirm"
          label="Confirm password"
          htmlFor="confirm"
          dependencies={["password"]}
          validateStatus={invitationFieldError("confirm") ? "error" : undefined}
          help={invitationFieldError("confirm")}
          rules={[
            { required: true },
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
            loading={invitationPending}
          >
            Save password and continue
          </Button>
        </Form.Item>
      </Form>

      <div className="mt-4 flex justify-end">
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          disabled={pending}
          onClick={startOver}
        >
          Start over
        </Button>
      </div>
    </>
  );
}
