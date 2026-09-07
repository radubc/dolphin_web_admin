/**
 * The one HTTP client the provider modules use.
 *
 * Everything outbound goes through `fetchJson`: a hard timeout (an integration
 * must never hang a run forever), `Accept: application/json`, no caching, and
 * a `ProviderError` for every failure so a run body can tell "the key is
 * wrong" from "they are rate limiting us" from "the JSON was not what we
 * expected" without parsing messages.
 *
 * **Nothing here ever logs a URL that carries a key.** The provider modules
 * send credentials as headers, never as query parameters, but `redactUrl` is
 * still applied to every message and every log line these modules produce: a
 * base URL an operator pasted a key into would otherwise travel into the run
 * row's `error` column.
 */

/** Why a provider call failed. The run body decides what each one means. */
export type ProviderErrorKind =
  /** 401 / 403: the API key is missing, wrong or not entitled. */
  | "auth"
  /** 429: too many requests, or the plan's credits are spent. */
  | "rate_limit"
  /** Timeout, DNS, connection reset — nothing was received. */
  | "network"
  /** A 4xx/5xx that is none of the above, or a body that did not parse. */
  | "bad_response";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;

  constructor(kind: ProviderErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/**
 * Replaces the value of any query parameter that looks like a credential with
 * `***`, so a URL can be put in a log line or an error message.
 *
 * `apikey` is in the list for a concrete reason, not for tidiness: Alpha
 * Vantage accepts its key **only** as a query parameter, so that one provider
 * really does build URLs with a credential in them. Every message and log line
 * this module produces goes through here first, and no caller may print a raw
 * URL of its own.
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:apikey|api_key|token|key)=)[^&]*/gi, "$1***");
}

export interface FetchJsonOptions {
  /** Milliseconds before the request is aborted. */
  timeoutMs: number;
  /** Appended to `Accept: application/json`. */
  headers?: Record<string, string>;
}

/**
 * GETs `url` and parses the body as JSON.
 *
 * The timeout is enforced with `AbortSignal.timeout`, which aborts the socket
 * rather than merely abandoning the promise, so a provider that accepts the
 * connection and then goes quiet cannot pin a run open.
 *
 * @throws {ProviderError} always, for every failure mode.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions): Promise<T> {
  const safeUrl = redactUrl(url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...options.headers },
      signal: AbortSignal.timeout(options.timeoutMs),
      // Provider data is fetched deliberately, on a schedule; never serve a
      // cached copy of it.
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new ProviderError("network", `Request to ${safeUrl} ${reason}.`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderError("auth", "API key missing or invalid.", response.status);
  }
  if (response.status === 429) {
    throw new ProviderError("rate_limit", "The provider is rate limiting us (429).", 429);
  }
  if (!response.ok) {
    throw new ProviderError(
      "bad_response",
      `${safeUrl} answered ${response.status}.`,
      response.status,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError("bad_response", `${safeUrl} did not answer JSON.`, response.status);
  }
}

/**
 * GETs `url` and returns the body as text, for a provider that publishes a
 * file rather than JSON (the ISO 10383 MIC register is a CSV).
 *
 * Same timeout, same `ProviderError` vocabulary and the same redaction as
 * `fetchJson`; only the parsing differs. A leading UTF-8 BOM is stripped here
 * rather than in every parser — the MIC file ships one, and a BOM glued to the
 * first header name silently breaks column matching.
 */
export async function fetchText(url: string, options: FetchJsonOptions): Promise<string> {
  const safeUrl = redactUrl(url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "text/csv, text/plain, */*", ...options.headers },
      signal: AbortSignal.timeout(options.timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new ProviderError("network", `Request to ${safeUrl} ${reason}.`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderError("auth", "API key missing or invalid.", response.status);
  }
  if (response.status === 429) {
    throw new ProviderError("rate_limit", "The provider is rate limiting us (429).", 429);
  }
  if (!response.ok) {
    throw new ProviderError(
      "bad_response",
      `${safeUrl} answered ${response.status}.`,
      response.status,
    );
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new ProviderError("bad_response", `${safeUrl} did not answer a body.`, response.status);
  }
  return body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
}

/** Parses a provider's stringy number. `null` for absent, empty or NaN. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A provider string field, trimmed; `""` when it is absent or not a string. */
export function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Sleeps, for pacing batches against a per-minute credit allowance.
 *
 * Deliberately **not** `unref`'d: a run that is mid-pause is work in
 * progress, not a background timer, and abandoning it would leave the run row
 * open until its heartbeat went stale.
 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
