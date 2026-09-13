"use client";

/**
 * The reporting half of the app's forms convention.
 *
 * The owner's rule: no red asterisks anywhere, and in exchange a failed submit
 * must always *name* the mandatory fields that were left empty. The marking
 * half of that lives in `src/app/providers.tsx` — the antd `ConfigProvider`
 * turns `requiredMark` off for every form, gives `required` the one message
 * template `"${label} is required"`, and scrolls to the first bad field. This
 * file is what the person reads at the top of the form afterwards.
 *
 * Wiring, in every add/edit form:
 *
 * ```tsx
 * const { errorSummary, onFinishFailed, reset } = useFormErrorSummary();
 * ...
 * <Form onFinish={(values) => { reset(); void save(values); }} onFinishFailed={onFinishFailed}>
 *   <FormErrorSummary summary={errorSummary} onClose={reset} />
 * ```
 *
 * and `reset()` again when the drawer is reopened, so yesterday's complaint is
 * not the first thing on screen.
 *
 * **Why the labels come out of the messages.** antd hands `onFinishFailed` the
 * field *paths* and their messages, never the labels — and the label is what a
 * person recognises. Since the global template is `"${label} is required"`,
 * every mandatory-field message literally begins with the label, so the suffix
 * is stripped back off here. Reading the labels out of the DOM instead would
 * mean a state write after the commit, which this project's lint rules
 * (`react-hooks/set-state-in-effect`) rightly refuse.
 *
 * A field that failed some *other* rule (a pattern, a cross-field check) has no
 * label to recover, so its own message is listed instead — nothing a form
 * validates is ever dropped from the summary — and the title says "need
 * attention" rather than claiming something mandatory is missing.
 */

import { useCallback, useState, type CSSProperties } from "react";
import { Alert } from "antd";

/**
 * The slice of antd's `ValidateErrorEntity` this needs. Structural on purpose:
 * the real type lives in `@rc-component/form`, a transitive dependency this app
 * does not import from directly, and a handler taking this shape is still
 * assignable to `FormProps["onFinishFailed"]`.
 */
export interface FormValidationFailure {
  errorFields: readonly {
    readonly name: readonly (string | number)[];
    readonly errors: readonly string[];
  }[];
}

/** What a failed submit came to: one entry per field, in form order. */
export interface FormErrorSummaryState {
  /** Field labels, or the rule's own message when there is no label to recover. */
  entries: string[];
  /** Whether at least one entry is a mandatory field left empty. */
  hasRequired: boolean;
}

/**
 * The tails of a "this is mandatory" message; what is left in front of one is
 * the label. The plural is here because a handful of fields keep a message of
 * their own for grammar's sake ("Exchanges are required") rather than let the
 * template turn their label into bad English.
 */
const REQUIRED_SUFFIXES = [" is required", " are required"] as const;

/** Last resort for a field with no message at all: `roleKeys` → "Role keys". */
function humaniseName(name: readonly (string | number)[]): string {
  const last = String(name.at(-1) ?? "");
  const spaced = last
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.replace(/^./, (letter) => letter.toUpperCase());
}

function summarise(info: FormValidationFailure): FormErrorSummaryState | null {
  const entries: string[] = [];
  let hasRequired = false;

  for (const field of info.errorFields ?? []) {
    const message = field.errors.find((text) => text.trim() !== "");
    const suffix =
      message === undefined
        ? undefined
        : REQUIRED_SUFFIXES.find((candidate) => message.endsWith(candidate));
    let entry: string;
    if (message === undefined) {
      entry = humaniseName(field.name);
    } else if (suffix !== undefined) {
      hasRequired = true;
      entry = message.slice(0, -suffix.length);
    } else {
      entry = message;
    }
    // A field with two failing rules is still one line.
    if (entry !== "" && !entries.includes(entry)) entries.push(entry);
  }

  return entries.length === 0 ? null : { entries, hasRequired };
}

/**
 * The summary's state and the two callbacks a form needs: `onFinishFailed`
 * goes on the `Form`, `reset` on the drawer's reopen and on a successful
 * submit.
 */
export function useFormErrorSummary(): {
  errorSummary: FormErrorSummaryState | null;
  onFinishFailed: (info: FormValidationFailure) => void;
  reset: () => void;
} {
  const [errorSummary, setErrorSummary] = useState<FormErrorSummaryState | null>(null);

  const onFinishFailed = useCallback((info: FormValidationFailure) => {
    setErrorSummary(summarise(info));
  }, []);

  const reset = useCallback(() => setErrorSummary(null), []);

  return { errorSummary, onFinishFailed, reset };
}

export interface FormErrorSummaryProps {
  /** `errorSummary` from the hook; null renders nothing. */
  summary: FormErrorSummaryState | null;
  /** Usually the hook's `reset`. */
  onClose: () => void;
  style?: CSSProperties;
  className?: string;
}

/** The alert itself, rendered at the top of the form body. */
export function FormErrorSummary({ summary, onClose, style, className }: FormErrorSummaryProps) {
  if (summary === null) return null;

  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      closable={{ onClose }}
      title={
        summary.hasRequired
          ? "Some required information is missing"
          : "Some fields need attention"
      }
      description={summary.entries.join(", ")}
      style={style}
      className={className}
    />
  );
}

export default FormErrorSummary;
