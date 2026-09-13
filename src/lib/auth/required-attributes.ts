/**
 * The user attributes an invited account may be asked for on the
 * "Set your password" step, and the rules for each one.
 *
 * When a user pool marks standard attributes as required, Cognito returns them
 * in `ChallengeParameters.requiredAttributes` of the NEW_PASSWORD_REQUIRED
 * challenge and refuses `RespondToAuthChallenge` until they arrive with the new
 * password. This module is the single description of what the form can ask for:
 * `src/lib/auth/cognito.ts` uses it to decide whether a challenge is answerable,
 * `src/app/login/actions.ts` re-validates the posted values against it, and
 * `src/app/login/login-form.tsx` renders one input per entry.
 *
 * Anything not listed here is deliberately *not* collectable — `updated_at`
 * (Cognito's own timestamp, meaningless to type), `email_verified` and friends.
 * A challenge that requires one of those is refused with a "contact support"
 * message rather than answered with an invented value; the pool needs fixing,
 * not the operator. `email` is never asked either: whoever ran
 * `AdminCreateUser` on the admin pool already set it, so it is dropped from the
 * list before it gets here.
 *
 * Ported from the consumer app (`../penny-squeeze-web/src/lib/auth/
 * required-attributes.ts`); keep the two in step.
 *
 * Plain module, no `"use server"` and nothing server-only: the Client Component
 * imports the same labels and validation the Server Action enforces, so the two
 * cannot drift. It holds no secrets — only attribute names and copy.
 */

/** How a value is normalised and checked. Everything else is plain text. */
type AttributeKind = "text" | "phone" | "date" | "locale";

/**
 * The locale sent when the browser reports none the pool would accept. The
 * step never asks the person for a locale: `navigator.language` is what the
 * console would format with anyway, and a wrong guess is corrected in the
 * profile later, not on a sign-in form.
 */
export const DEFAULT_LOCALE = "en-US";

/** True for attributes the step fills in itself rather than asking for. */
export function isSilentAttribute(spec: RequiredAttributeSpec): boolean {
  return spec.kind === "locale";
}

/**
 * The locale to send for a browser language such as `en-CA` or `fr`. A tag
 * the validator would refuse falls back to {@link DEFAULT_LOCALE}.
 */
export function localeFromBrowser(language: string | undefined): string {
  const candidate = normaliseLocale((language ?? "").trim());
  return BCP47.test(candidate) ? candidate : DEFAULT_LOCALE;
}

interface AttributeDefinition {
  label: string;
  kind?: AttributeKind;
  /** Browser autofill token, when one fits. */
  autoComplete?: string;
  placeholder?: string;
  /** Rendered under the input, always visible. */
  hint?: string;
}

/**
 * The allowlist. A required attribute outside it (or outside `custom:*`) makes
 * the whole challenge unanswerable — see {@link isRenderableAttribute}.
 */
const RENDERABLE_ATTRIBUTES: Record<string, AttributeDefinition> = {
  name: { label: "Full name", autoComplete: "name" },
  given_name: { label: "First name", autoComplete: "given-name" },
  family_name: { label: "Last name", autoComplete: "family-name" },
  middle_name: { label: "Middle name", autoComplete: "additional-name" },
  nickname: { label: "Nickname", autoComplete: "nickname" },
  // No `autoComplete`: the read-only email input above it already claims
  // `username`, and two of them make password managers fill the wrong one.
  preferred_username: { label: "Username" },
  phone_number: {
    label: "Phone number",
    kind: "phone",
    autoComplete: "tel",
    placeholder: "+15551234567",
    hint: "Digits and a country code: +1 555 123 4567 → +15551234567",
  },
  birthdate: {
    label: "Date of birth",
    kind: "date",
    autoComplete: "bday",
    placeholder: "YYYY-MM-DD",
    hint: "YYYY-MM-DD",
  },
  address: { label: "Address", autoComplete: "street-address" },
  gender: { label: "Gender" },
  // Filled in from the browser, never shown; see `isSilentAttribute`.
  locale: { label: "Language and region", kind: "locale" },
  zoneinfo: { label: "Time zone", placeholder: "America/Toronto" },
  website: { label: "Website", placeholder: "https://example.com" },
  picture: { label: "Picture URL", placeholder: "https://example.com/me.jpg" },
  profile: { label: "Profile URL", placeholder: "https://example.com/me" },
};

/** Custom attributes are always `custom:<name>` in the challenge parameters. */
const CUSTOM_PREFIX = "custom:";

/**
 * Set at `AdminCreateUser` on the admin pool, so Cognito should never ask for
 * it — and if it
 * does, asking the user again would only invite a mismatch with the address
 * they just signed in with. Dropped from the list, not refused.
 */
export const NEVER_REQUESTED_ATTRIBUTES = new Set(["email"]);

/** Cognito's own cap for a string attribute value. */
export const MAX_ATTRIBUTE_LENGTH = 256;

/**
 * A sane ceiling on how many inputs the step will render. A pool asking for
 * more than this is misconfigured, and the number also bounds what a tampered
 * post can make the server loop over.
 */
export const MAX_REQUIRED_ATTRIBUTES = 20;

/** Attribute names are `[A-Za-z0-9_.:-]`; anything else is not from Cognito. */
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Prefix for the form inputs, so no attribute can shadow `password` et al. */
const FIELD_PREFIX = "attr_";

/** Everything the form and the actions need to handle one attribute. */
export interface RequiredAttributeSpec {
  /** Cognito attribute name, e.g. `given_name` or `custom:team`. */
  name: string;
  /** Name of the form input carrying it, e.g. `attr_given_name`. */
  field: string;
  label: string;
  kind: AttributeKind;
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
}

/** The form input that carries `name`. */
export function attributeFieldName(name: string): string {
  return `${FIELD_PREFIX}${name}`;
}

/** `custom:job_title` -> "Job title". */
function humaniseCustom(rawName: string): string {
  const words = rawName.replace(/[_-]+/g, " ").trim();
  if (words === "") {
    return "Detail";
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The spec for one Cognito attribute name, or `null` when the form cannot ask
 * for it.
 *
 * `name` is untrusted (it arrives from Cognito, and on the second step from a
 * hidden input the browser sent back), so the lookup is an own-property check
 * against the allowlist — never a bare index, which would happily resolve
 * `constructor` or `toString`.
 */
export function attributeSpec(name: string): RequiredAttributeSpec | null {
  if (!ATTRIBUTE_NAME_PATTERN.test(name) || NEVER_REQUESTED_ATTRIBUTES.has(name)) {
    return null;
  }

  if (name.startsWith(CUSTOM_PREFIX)) {
    const rawName = name.slice(CUSTOM_PREFIX.length);
    if (rawName === "" || rawName.includes(":")) {
      return null;
    }
    return {
      name,
      field: attributeFieldName(name),
      label: humaniseCustom(rawName),
      kind: "text",
    };
  }

  if (!Object.hasOwn(RENDERABLE_ATTRIBUTES, name)) {
    return null;
  }
  const definition = RENDERABLE_ATTRIBUTES[name];
  return {
    name,
    field: attributeFieldName(name),
    label: definition.label,
    kind: definition.kind ?? "text",
    autoComplete: definition.autoComplete,
    placeholder: definition.placeholder,
    hint: definition.hint,
  };
}

/** Whether the "Set your password" step can collect `name`. */
export function isRenderableAttribute(name: string): boolean {
  return attributeSpec(name) !== null;
}

/**
 * Specs for the attributes to render, in the order Cognito listed them.
 * Duplicates and anything unrenderable are dropped — sign-in refuses the
 * challenge before it gets this far, so by here the list is already known-good.
 */
export function requiredAttributeSpecs(
  names: readonly string[],
): RequiredAttributeSpec[] {
  const specs: RequiredAttributeSpec[] = [];
  const seen = new Set<string>();
  for (const name of names.slice(0, MAX_REQUIRED_ATTRIBUTES)) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const spec = attributeSpec(name);
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

/**
 * Reads the `attribute_names` hidden field back off the second step.
 *
 * The browser is telling the server what Cognito asked for, which makes it
 * untrusted input: every name goes through the same allowlist, so a tampered
 * post can only ever name attributes the form itself could have rendered.
 */
export function parseAttributeNames(raw: string): string[] {
  return requiredAttributeSpecs(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  ).map((spec) => spec.name);
}

/** Strips the punctuation people put in phone numbers. */
function normalisePhone(value: string): string {
  return value.replace(/[\s().-]/g, "");
}

/** Whitespace off both ends; phone numbers lose their internal spacing too. */
export function normaliseAttributeValue(
  spec: RequiredAttributeSpec,
  raw: string,
): string {
  const trimmed = raw.trim();
  if (spec.kind === "phone") return normalisePhone(trimmed);
  if (spec.kind === "locale") return normaliseLocale(trimmed);
  return trimmed;
}

/** BCP 47 as Cognito accepts it: a language, optionally followed by subtags. */
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** `en-ca` -> `en-CA`: language lower-case, a two-letter region upper-case. */
function normaliseLocale(value: string): string {
  const parts = value.split("-");
  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      return part.length === 2 ? part.toUpperCase() : part;
    })
    .join("-");
}

/** A real calendar date, not just four-two-two digits. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** The message shown when a required attribute is left empty. */
export function attributeRequiredMessage(spec: RequiredAttributeSpec): string {
  return `Enter your ${spec.label.toLowerCase()}.`;
}

/**
 * Normalises and checks one value. The client runs this to show the error
 * inline; the Server Action runs it again on what actually arrived, and sends
 * `value` — not the raw input — to Cognito.
 */
export function validateAttributeValue(
  spec: RequiredAttributeSpec,
  raw: string,
): { value: string; error?: string } {
  const value = normaliseAttributeValue(spec, raw);

  if (value === "") {
    return { value, error: attributeRequiredMessage(spec) };
  }
  if (value.length > MAX_ATTRIBUTE_LENGTH) {
    return {
      value,
      error: `Use ${MAX_ATTRIBUTE_LENGTH} characters or fewer.`,
    };
  }
  if (spec.kind === "phone" && !/^\+[1-9]\d{1,14}$/.test(value)) {
    return {
      value,
      error:
        "Use the international format: a plus, the country code, then digits (+15551234567).",
    };
  }
  if (spec.kind === "date" && !isCalendarDate(value)) {
    return { value, error: "Use the format YYYY-MM-DD." };
  }
  if (spec.kind === "locale" && !BCP47.test(value)) {
    return { value, error: "Use a language tag such as en-CA." };
  }
  return { value };
}
