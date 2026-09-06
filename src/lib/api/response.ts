/**
 * The response envelope every Route Handler returns.
 *
 * Success: `{ "data": ... }`. Failure: `{ "error": { "code", "message", "details"? } }`.
 * Clients can therefore branch on the presence of `data` vs `error` without
 * looking at the status code first.
 *
 * Every response carries `Cache-Control: no-store`: this API is per-user, and
 * an intermediary caching one caller's payload for another would be a data leak.
 */
import { isTooManyRequestsError, type ApiError } from "./errors";

export const NO_STORE = "no-store";

export interface ApiSuccessBody<T> {
  data: T;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Builds the header set for a JSON response, keeping anything the caller
 * supplied in `init` while forcing `Cache-Control: no-store`.
 */
function jsonHeaders(init?: ResponseInit): Headers {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", NO_STORE);
  return headers;
}

/** 200 (or the status in `init`) with the `{ data }` envelope. */
export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data } satisfies ApiSuccessBody<T>, {
    ...init,
    status: init?.status ?? 200,
    headers: jsonHeaders(init),
  });
}

/** 201 for a resource that was just created. */
export function created<T>(data: T, init?: ResponseInit): Response {
  return ok(data, { ...init, status: 201 });
}

/** 204 with no body, for deletes and other write-only operations. */
export function noContent(init?: ResponseInit): Response {
  return new Response(null, {
    ...init,
    status: 204,
    headers: jsonHeaders(init),
  });
}

/**
 * Builds the headers a rate-limited refusal carries: `Retry-After` in seconds,
 * plus the `X-RateLimit-*` trio when the error brought a verdict along.
 *
 * `X-RateLimit-Reset` is epoch **seconds** (the GitHub convention), not a delta;
 * `Retry-After` is the delta. Both are present so a client can use either.
 */
function applyRateLimitHeaders(headers: Headers, error: ApiError): void {
  if (!isTooManyRequestsError(error)) {
    return;
  }
  headers.set("Retry-After", String(error.retryAfterSeconds));
  const snapshot = error.rateLimit;
  if (!snapshot) {
    return;
  }
  headers.set("X-RateLimit-Limit", String(snapshot.limit));
  headers.set("X-RateLimit-Remaining", String(snapshot.remaining));
  headers.set("X-RateLimit-Reset", String(Math.ceil(snapshot.resetAt / 1000)));
}

/**
 * Renders an `ApiError` as the `{ error }` envelope. `details` is omitted
 * entirely when undefined so clients never see a null placeholder.
 */
export function errorResponse(error: ApiError): Response {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  const headers = new Headers({ "Cache-Control": NO_STORE });
  applyRateLimitHeaders(headers, error);
  return Response.json(body, {
    status: error.status,
    headers,
  });
}
