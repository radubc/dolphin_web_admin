import "server-only";
/**
 * The wrapper every Route Handler is exported through.
 *
 * It gives each endpoint four things for free:
 *
 * - **Error translation.** A thrown `ApiError` becomes its declared status and
 *   code; anything else is a bug and becomes a generic 500, with the real error
 *   logged server-side and never sent to the client.
 * - **A request id.** Taken from an inbound `x-request-id` when it looks sane,
 *   otherwise generated. It is echoed on every response and printed with every
 *   error log, so a user-reported failure can be found in the logs.
 * - **Rate limiting**, per client IP by default, applied *before* the handler
 *   and before authentication so a flood is rejected as cheaply as possible.
 *   Per-IP policies are skipped entirely when no address can be trusted (see
 *   `TRUST_PROXY_HEADERS` in `src/lib/security/client-ip.ts`).
 * - **Authentication**, via `protectedHandler`, or an API key via
 *   `serviceHandler`.
 */
import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import type { Session } from "@/lib/auth/session";
import { clientIp, ipRateLimitKey } from "@/lib/security/client-ip";
import {
  enforceRateLimit,
  RATE_LIMITS,
  type RateLimitPolicy,
  type RateLimitVerdict,
} from "@/lib/security/rate-limit";
import { requireApiKey, type ApiKeyClient } from "./api-key";
import { authenticate } from "./auth";
import { ApiError, isApiError } from "./errors";
import { errorResponse, NO_STORE } from "./response";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Inbound ids are echoed into a response header, so only accept a conservative
 * character set and length. Anything else gets a fresh id instead.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~+/=@:-]{1,128}$/;

/** Per-endpoint knobs. Every field is optional; the defaults are the policy. */
export interface HandlerOptions {
  /**
   * Policies applied per client IP before the handler runs.
   *
   * Omitted: `RATE_LIMITS.api`. One policy or several (all are consumed; the
   * first one supplies the `X-RateLimit-*` headers on a successful response).
   * `null`: no IP limiting at all — only for an endpoint that limits itself.
   *
   * Whatever is configured here is skipped when the client address is unknown;
   * an endpoint that must stay limited in that case has to key on something
   * else (the user id, an API key) the way `protectedHandler` does.
   */
  rateLimit?: RateLimitPolicy | RateLimitPolicy[] | null;
}

function resolveRequestId(request: Request): string {
  const incoming = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (incoming && SAFE_REQUEST_ID.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

/** Normalises the `rateLimit` option into the list of policies to consume. */
function resolvePolicies(
  option: HandlerOptions["rateLimit"],
): RateLimitPolicy[] {
  if (option === null) {
    return [];
  }
  if (option === undefined) {
    return [RATE_LIMITS.api];
  }
  return Array.isArray(option) ? option : [option];
}

/**
 * Consumes every configured policy for this caller's IP.
 *
 * With no trustworthy address there is no key to count against, so every policy
 * here is skipped and the response advertises no `X-RateLimit-*` budget —
 * advertising one that is never charged would be a lie. `protectedHandler` and
 * `serviceHandler` still charge their per-user and per-key budgets.
 *
 * @returns the verdict of the first policy, whose numbers are advertised to the
 * client, or `undefined` when no policy applies.
 * @throws {TooManyRequestsError} as soon as one policy is exhausted.
 */
async function enforceIpPolicies(
  request: Request,
  policies: RateLimitPolicy[],
): Promise<RateLimitVerdict | undefined> {
  if (policies.length === 0) {
    return undefined;
  }
  const key = ipRateLimitKey("ip:", clientIp(request));
  if (key === null) {
    return undefined;
  }
  let primary: RateLimitVerdict | undefined;
  for (const policy of policies) {
    const verdict = await enforceRateLimit(key, policy);
    primary ??= verdict;
  }
  return primary;
}

/** Turns a thrown value into a client-safe response, logging what matters. */
function toErrorResponse(
  error: unknown,
  request: Request,
  requestId: string,
): Response {
  // `redirect()`, `notFound()`, `unauthorized()` and friends work by throwing
  // a control-flow error Next expects to see again. Hand those back untouched;
  // swallowing them into a 500 would break every handler that uses them.
  unstable_rethrow(error);

  const where = `${request.method} ${new URL(request.url).pathname}`;

  if (isApiError(error)) {
    // 4xx is the client's problem and is already described by the payload;
    // 5xx is ours and deserves a log line.
    if (error.status >= 500) {
      console.error(`[api] ${where} [${requestId}] ${error.code}:`, error);
    }
    return errorResponse(error);
  }

  console.error(`[api] ${where} [${requestId}] unhandled error:`, error);
  return errorResponse(
    new ApiError(500, "internal_error", "Something went wrong."),
  );
}

/**
 * Stamps the request id and, when the handler did not decide otherwise, the
 * `no-store` cache policy and the rate-limit budget onto a response. A few
 * `Response` factories (notably the plain `Response.redirect()`) return
 * immutable headers; those are rebuilt into a mutable copy instead of throwing
 * out of the wrapper.
 *
 * A refusal built by `errorResponse` already carries its own `X-RateLimit-*`
 * and `Retry-After`, so nothing here overwrites an existing value.
 */
function withStandardHeaders(
  response: Response,
  requestId: string,
  verdict?: RateLimitVerdict,
): Response {
  let target = response;
  try {
    target.headers.set(REQUEST_ID_HEADER, requestId);
  } catch {
    target = new Response(response.body, response);
    target.headers.set(REQUEST_ID_HEADER, requestId);
  }
  if (!target.headers.has("Cache-Control")) {
    target.headers.set("Cache-Control", NO_STORE);
  }
  if (verdict && !target.headers.has("X-RateLimit-Limit")) {
    target.headers.set("X-RateLimit-Limit", String(verdict.limit));
    target.headers.set("X-RateLimit-Remaining", String(verdict.remaining));
  }
  return target;
}

/**
 * Wraps a Route Handler with rate limiting, error translation and the request
 * id header.
 *
 * `Ctx` defaults to `unknown` so handlers without dynamic segments need no type
 * argument. For a dynamic route, pass the generated context type:
 * `apiHandler<RouteContext<"/api/v1/accounts/[id]">>(async (request, ctx) => {
 *   const { id } = await ctx.params;
 * })`.
 */
export function apiHandler<Ctx = unknown>(
  fn: (request: NextRequest, ctx: Ctx) => Promise<Response>,
  options?: HandlerOptions,
): (request: NextRequest, ctx: Ctx) => Promise<Response> {
  const policies = resolvePolicies(options?.rateLimit);
  return async (request: NextRequest, ctx: Ctx): Promise<Response> => {
    const requestId = resolveRequestId(request);
    let verdict: RateLimitVerdict | undefined;
    let response: Response;
    try {
      verdict = await enforceIpPolicies(request, policies);
      response = await fn(request, ctx);
    } catch (error) {
      response = toErrorResponse(error, request, requestId);
    }
    return withStandardHeaders(response, requestId, verdict);
  };
}

/**
 * Same as {@link apiHandler}, but resolves the caller first and hands the
 * verified `Session` to the handler. Unauthenticated callers get a 401 (or a
 * 503 if Cognito itself is unreachable) and `fn` never runs.
 *
 * A second `RATE_LIMITS.api` budget is charged per user id on top of the per-IP
 * one, so a whole office behind a single NAT address does not share one bucket,
 * and one compromised account cannot spend the whole building's budget.
 */
export function protectedHandler<Ctx = unknown>(
  fn: (request: NextRequest, ctx: Ctx, session: Session) => Promise<Response>,
  options?: HandlerOptions,
): (request: NextRequest, ctx: Ctx) => Promise<Response> {
  return apiHandler<Ctx>(async (request, ctx) => {
    const session = await authenticate(request);
    await enforceRateLimit(`user:${session.userId}`, RATE_LIMITS.api);
    return fn(request, ctx, session);
  }, options);
}

/**
 * Same as {@link apiHandler}, but for machine-to-machine endpoints: the caller
 * must present a valid `API_KEYS` entry, and gets the much higher
 * `RATE_LIMITS.service` budget keyed by that key's opaque id (on top of the
 * per-IP one).
 *
 * Never use this for anything a browser calls; see `src/lib/api/api-key.ts`.
 */
export function serviceHandler<Ctx = unknown>(
  fn: (
    request: NextRequest,
    ctx: Ctx,
    client: ApiKeyClient,
  ) => Promise<Response>,
  options?: HandlerOptions,
): (request: NextRequest, ctx: Ctx) => Promise<Response> {
  return apiHandler<Ctx>(async (request, ctx) => {
    const client = requireApiKey(request);
    await enforceRateLimit(`key:${client.keyId}`, RATE_LIMITS.service);
    return fn(request, ctx, client);
  }, options);
}
