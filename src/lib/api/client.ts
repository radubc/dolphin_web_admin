/**
 * The browser's way of calling this API.
 *
 * Client-safe on purpose (no `server-only`, no imports from `src/lib/auth/`):
 * Client Components import it directly. It knows three things the raw `fetch`
 * does not:
 *
 * - the `{ data } | { error }` envelope, which it unwraps or throws;
 * - that the session lives in cookies, so every call is `same-origin` with
 *   credentials attached;
 * - what `token_expired` means — refresh once, retry once, and only then give
 *   up and send the user to /login.
 *
 * Server Components and Server Actions must not use this: they import the
 * `src/lib/*` function directly instead of calling their own HTTP API.
 */

const REFRESH_ENDPOINT = "/api/auth/refresh";
const LOGIN_PATH = "/login";

/** Code the API uses for "the id token ran out, but a refresh may work". */
const TOKEN_EXPIRED = "token_expired";

/** A failure the server described in the `{ error }` envelope. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiFetchInit extends Omit<RequestInit, "body"> {
  /** Serialised as a JSON body, with the content type set for you. */
  json?: unknown;
  body?: BodyInit | null;
}

interface EnvelopeError {
  code?: unknown;
  message?: unknown;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads the envelope, tolerating a body that is empty or not JSON at all. */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Turns a non-2xx response into an `ApiClientError`, falling back to the status
 * when the body is not one of ours (a proxy's error page, say).
 */
function toError(response: Response, body: unknown): ApiClientError {
  const envelope: EnvelopeError = isRecord(body) && isRecord(body.error)
    ? (body.error as EnvelopeError)
    : {};
  const code = typeof envelope.code === "string" ? envelope.code : "unknown";
  const message =
    typeof envelope.message === "string" && envelope.message !== ""
      ? envelope.message
      : `Request failed with status ${response.status}.`;
  return new ApiClientError(response.status, code, message, envelope.details);
}

/** What `POST /api/auth/refresh` answered, flattened for the callers. */
export interface SessionRefreshResult {
  /** The session was renewed and the cookies rewritten. */
  ok: boolean;
  /** The HTTP status, or 0 when the request never got an answer at all. */
  status: number;
  /** The error code from the envelope on a failure (`session_idle`, …). */
  code: string | null;
  /** The new id token's `exp`, epoch seconds, when the server sent one. */
  idTokenExpiresAt: number | null;
  /** The new access token's lifetime in seconds, when the server sent one. */
  expiresIn: number | null;
}

function refreshResultFrom(response: Response, body: unknown): SessionRefreshResult {
  const data = isRecord(body) && isRecord(body.data) ? body.data : {};
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  return {
    ok: response.ok,
    status: response.status,
    code: typeof error.code === "string" ? error.code : null,
    idTokenExpiresAt:
      typeof data.idTokenExpiresAt === "number" ? data.idTokenExpiresAt : null,
    expiresIn: typeof data.expiresIn === "number" ? data.expiresIn : null,
  };
}

/** The shape a network failure gets: nothing was learned, so nothing is claimed. */
const REFRESH_UNREACHABLE: SessionRefreshResult = {
  ok: false,
  status: 0,
  code: null,
  idTokenExpiresAt: null,
  expiresIn: null,
};

let inFlightRefresh: Promise<SessionRefreshResult> | null = null;

/**
 * Asks the server to spend the refresh cookie, at most once at a time.
 *
 * Several requests can fail with `token_expired` at the same moment, and the
 * keepalive timer can come due in the middle of one; letting them all POST
 * would burn several refresh tokens once rotation is enabled, so they share one
 * call and one answer.
 *
 * Exported because `SessionKeepalive` refreshes *before* anything fails, and it
 * must go through this same de-duplication. It never throws: a failure is a
 * result with `ok: false`, and the caller decides what to do about it.
 */
export function refreshSessionOnce(): Promise<SessionRefreshResult> {
  inFlightRefresh ??= fetch(REFRESH_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
    .then(async (response) => refreshResultFrom(response, await readBody(response)))
    .catch(() => REFRESH_UNREACHABLE)
    .finally(() => {
      inFlightRefresh = null;
    });
  return inFlightRefresh;
}

/**
 * Whether the body can only be sent once.
 *
 * A `ReadableStream` body is consumed by the first `fetch`; replaying the
 * request would send an empty or already-locked stream. `typeof` guard because
 * this module is also imported into environments without the global.
 */
function isSingleUseBody(body: BodyInit | null | undefined): boolean {
  return typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
}

function buildInit(init: ApiFetchInit): RequestInit {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (json !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return {
    ...rest,
    credentials: "same-origin",
    headers,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  };
}

/**
 * Calls a same-origin API route and returns the unwrapped `data`.
 *
 * `path` must be a relative path such as `/api/v1/me`: this helper only ever
 * talks to this origin, and sending the session cookie anywhere else would be
 * a credential leak.
 *
 * On a 401 `token_expired` it refreshes the session once and replays the
 * request once. That is safe even for a POST: the original never reached the
 * handler's body — authentication rejected it first — so nothing was applied.
 * If the refresh fails the browser is sent to /login and the original error is
 * still thrown, so a caller awaiting it is not left hanging.
 *
 * **The retry cannot replay a streaming body.** A `ReadableStream` passed as
 * `body` is consumed by the first attempt, so when one is given the retry is
 * skipped and the `token_expired` error is thrown as it stands; the caller
 * refreshes (`POST /api/auth/refresh`) and re-issues the request with a fresh
 * stream. `json` and every buffered `BodyInit` — string, `FormData`,
 * `URLSearchParams`, `Blob`, `ArrayBuffer` — replay normally.
 *
 * @throws {ApiClientError} for any non-2xx response.
 */
export async function apiFetch<T>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("apiFetch expects a same-origin path, e.g. /api/v1/me.");
  }

  const requestInit = buildInit(init);
  let response = await fetch(path, requestInit);
  let body = await readBody(response);

  if (response.status === 401 && path !== REFRESH_ENDPOINT) {
    const error = toError(response, body);
    if (error.code === TOKEN_EXPIRED) {
      if (isSingleUseBody(requestInit.body)) {
        // The stream is spent; a replay would send nothing. Hand the caller the
        // `token_expired` code so it can refresh and rebuild the request.
        throw error;
      }
      if ((await refreshSessionOnce()).ok) {
        // One retry, never a loop: a second 401 falls through to the throw.
        response = await fetch(path, requestInit);
        body = await readBody(response);
      } else {
        if (typeof window !== "undefined") {
          // A hard navigation on purpose, not `router.push`: the session is
          // gone, so every cached RSC payload and piece of client state built
          // for that user has to go with it. This module also has no router.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(LOGIN_PATH);
        }
        throw error;
      }
    }
  }

  if (!response.ok) {
    throw toError(response, body);
  }

  if (body === undefined) {
    // 204, or a handler that answered with no body at all.
    return undefined as T;
  }
  return (isRecord(body) ? (body.data as T) : (body as T));
}
