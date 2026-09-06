/**
 * Error types for the Route Handler API.
 *
 * Anything thrown as an `ApiError` is a deliberate, client-facing verdict: its
 * `status`, `code` and `message` are sent to the caller as-is. Everything else
 * that escapes a handler is treated as a bug and answered with a generic 500
 * (see `src/lib/api/handler.ts`), so never put internal detail in a message.
 *
 * `code` values are stable snake_case identifiers. Clients switch on them, so
 * treat a rename as a breaking API change.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Optional machine-readable payload, echoed to the client verbatim. */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 400 — the request itself is malformed (bad JSON, wrong content type, too big). */
export class BadRequestError extends ApiError {
  constructor(message = "The request could not be understood.", details?: unknown) {
    super(400, "bad_request", message, details);
    this.name = "BadRequestError";
  }
}

/** 401 — no usable credentials were presented. */
export class UnauthorizedError extends ApiError {
  constructor(message = "Authentication required.", details?: unknown) {
    super(401, "unauthorized", message, details);
    this.name = "UnauthorizedError";
  }
}

/** 403 — the caller is known but not allowed to do this. */
export class ForbiddenError extends ApiError {
  constructor(message = "You do not have access to this resource.", details?: unknown) {
    super(403, "forbidden", message, details);
    this.name = "ForbiddenError";
  }
}

/** 404 — the resource does not exist, or is not visible to this caller. */
export class NotFoundError extends ApiError {
  constructor(message = "Not found.", details?: unknown) {
    super(404, "not_found", message, details);
    this.name = "NotFoundError";
  }
}

/** 409 — the request conflicts with current state (duplicate, stale version). */
export class ConflictError extends ApiError {
  constructor(message = "The request conflicts with the current state.", details?: unknown) {
    super(409, "conflict", message, details);
    this.name = "ConflictError";
  }
}

/**
 * 422 — the request was well-formed but failed schema validation. `details`
 * carries the flattened zod issues so a form can highlight the offending fields.
 */
export class ValidationError extends ApiError {
  constructor(message = "The submitted data is invalid.", details?: unknown) {
    super(422, "validation_failed", message, details);
    this.name = "ValidationError";
  }
}

/**
 * The part of a rate-limit verdict that is safe to advertise in headers.
 *
 * Declared here rather than imported from `src/lib/security/rate-limit.ts` so
 * that the error module keeps zero dependencies: the limiter throws these
 * errors, so the arrow may only point one way.
 */
export interface RateLimitSnapshot {
  /** Requests allowed per window. */
  limit: number;
  /** Requests still available in the current window. */
  remaining: number;
  /** Epoch milliseconds at which the window frees up. */
  resetAt: number;
}

/**
 * 429 — the caller exceeded a rate-limit policy.
 *
 * `retryAfterSeconds` is rendered as the `Retry-After` header, and the optional
 * snapshot as the `X-RateLimit-*` headers (see `src/lib/api/response.ts`). The
 * message never names the policy or its window: telling an attacker exactly how
 * long to sleep makes the limiter easier to pace around.
 */
export class TooManyRequestsError extends ApiError {
  /** Always at least 1; `Retry-After: 0` invites an immediate retry. */
  readonly retryAfterSeconds: number;
  readonly rateLimit?: RateLimitSnapshot;

  constructor(
    retryAfterSeconds: number,
    rateLimit?: RateLimitSnapshot,
    message = "Too many requests. Please slow down and try again.",
  ) {
    super(429, "rate_limited", message);
    this.name = "TooManyRequestsError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    this.rateLimit = rateLimit;
  }
}

/**
 * 503 — a dependency we need to answer the request is down (for example the
 * Cognito JWKS endpoint). Distinct from 401: the credential was never judged.
 */
export class ServiceUnavailableError extends ApiError {
  constructor(code: string, message: string, details?: unknown) {
    super(503, code, message, details);
    this.name = "ServiceUnavailableError";
  }
}

/** Narrows an unknown throwable to an `ApiError`. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Narrows an unknown throwable to a 429 `TooManyRequestsError`. */
export function isTooManyRequestsError(
  error: unknown,
): error is TooManyRequestsError {
  return error instanceof TooManyRequestsError;
}
