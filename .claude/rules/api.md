---
paths:
  - "src/app/api/**"
  - "src/lib/api/**"
  - "src/lib/security/**"
---

# Backend API conventions

The backend is Next.js Route Handlers. There is no separate Express/Fastify process.

**Status:** `src/lib/api/` and `src/lib/security/` are ported verbatim from the consumer app (`../penny-squeeze-web`), and `/api/health`, `/api/auth/*` and `/api/v1/me` exist. Keep the two copies in step rather than diverging; the conventions below are the shared contract, with the admin-specific differences called out. Authorization lives in `src/lib/admin-access/authorize.ts`: export operator routes through `adminHandler(fn, { endpoint: "<key>" })`, never through bare `protectedHandler`; the key must exist in `endpoint-registry.ts`, and the rule (actions, super-admin, enabled) is read from `admin_endpoints` at request time. Public and session routes still pass `{ endpoint }` so usage is counted.

- Handlers live in `src/app/api/`. Business endpoints are versioned: `/api/v1/...`. Operational endpoints (`/api/health`) stay unversioned.
- Handlers are thin: parse and validate input, call logic in `src/lib/*`, shape the response. Business rules and database access belong in `src/lib/`, not in `route.ts`.
- Export every handler through `apiHandler` (public) or `protectedHandler` (authenticated) from `src/lib/api/handler.ts`. Never export a bare `GET`/`POST`.
- **Admin difference:** `protectedHandler` is not enough on its own. `adminHandler` resolves the allowlist row and evaluates the endpoint's rule from the access map (`evaluateRule` in `types.ts`): unregistered or refused is 403 `forbidden`, disabled is 503 `endpoint_disabled`. Handlers never hard-code action keys; the reviewer greps for routes missing `{ endpoint }` or a registry entry. See `docs/access-control.md`.
- Validate every body and query string with zod through `src/lib/api/validate.ts` (`parseJsonBody`, `parseSearchParams`). Never trust `await request.json()` directly.
- Response envelope, built with `src/lib/api/response.ts`:
  - success `{ "data": ... }` via `ok()` / `created()` / `noContent()`
  - failure `{ "error": { "code", "message", "details"? } }` via a thrown `ApiError`
- Signal failure by throwing from `src/lib/api/errors.ts`; the wrapper renders it. Stable codes: `bad_request` (400), `unauthorized` (401), `token_expired` (401, cookie session expired — the client should `POST /api/auth/refresh` once and retry), `refresh_failed` (401, refresh token gone or rejected — sign in again), `invalid_api_key` (401), `forbidden` (403, includes "not on the admin allowlist" and "action not granted"; do not distinguish them in the message), `csrf_rejected` (403), `not_found` (404), `conflict` (409), `validation_failed` (422, `details` = flattened zod issues), `rate_limited` (429), `auth_unavailable` (503), `api_keys_not_configured` (503), `database_unavailable` (503, health only), `internal_error` (500). Codes are a public contract — renaming one is a breaking change.
- Never let an internal error message reach the client. Anything that is not an `ApiError` becomes a generic 500; log it with a `[api]` prefix instead.
- Auth: `authenticate()` accepts an `Authorization: Bearer <cognito id token>` header first, then the id-token cookie. Tokens are verified against the **admin** user pool only. A JWKS/config outage is a 503 `auth_unavailable`, never a 401.
- Every response carries `Cache-Control: no-store` (per-operator data) and an `x-request-id` header, echoed from the request when present. Include the request id in error logs.
- A route that must work without credentials has to be added to `PUBLIC_API_PATHS` in `src/proxy.ts` (`/api/health`, `/api/auth/refresh`, `/api/auth/logout`); otherwise the proxy answers a credential-less request with a JSON 401. The proxy never redirects `/api/*` to `/login`, and it lets `OPTIONS` preflights through untouched.
- CSRF: cookie-authenticated requests with a method other than GET/HEAD/OPTIONS must pass `assertSameOrigin()` inside `authenticate()` (`Sec-Fetch-Site`, then `Origin` vs `Host`), on top of the `sameSite: "lax"` cookie. Bearer requests are exempt. Session cookies and refresh flows are described in `.claude/rules/auth.md`; Client Components call the API through `apiFetch()` in `src/lib/api/client.ts`, which refreshes and retries once.
- `redirect()`, `notFound()` and the other throwing helpers from `next/navigation` work inside `apiHandler`; the wrapper rethrows them, so those responses are built by Next and carry no `x-request-id`. Prefer returning `NextResponse.redirect(...)` when the id matters.
- Do not `fetch()` a Route Handler from a Server Component or Server Action — import the `src/lib/*` function directly. Route Handlers exist for browser fetches from Client Components.
- Never import a Prisma client, `src/lib/api/auth.ts`, or `src/lib/auth/session.ts` into a `"use client"` file. The `server-only` import in those modules turns that mistake into a build error.
- Dynamic segments: `ctx.params` is a Promise, `await` it. Type it with the generated helper, e.g. `apiHandler<RouteContext<"/api/v1/users/[id]">>(...)`.

## Rate limiting

`src/lib/security/rate-limit.ts`. In-process sliding window behind a `RateLimiter` interface; a shared store swaps in at `getRateLimiter()` and nowhere else.

- Presets in `RATE_LIMITS` (names are stable, numbers are tuning): `api` 120/min, `authLogin` 10 per 15 min per IP, `authLoginAccount` 5 per 15 min per email, `authReset` 5 per 15 min, `authRefresh` 30 per 15 min, `health` 30/min, `service` 600/min. An admin app has few operators; tighten, never loosen, these when porting.
- `apiHandler`/`protectedHandler`/`serviceHandler` take `{ rateLimit }`: omit it for the default `RATE_LIMITS.api` per IP, pass one policy or an array, or pass `null` to opt out (only for an endpoint that limits itself). Limiting runs before authentication; `protectedHandler` charges a second `api` budget per `user:<sub>` afterwards.
- Elsewhere (Server Actions), call `enforceRateLimit(key, policy)` directly, always **before** the expensive/authoritative call. It throws `TooManyRequestsError`; catch it with `isTooManyRequestsError` and return a neutral message that names no window and no policy.
- Key prefixes say what the key is: `ip:`, `user:`, `key:`, `login:ip:`, `login:email:`, `reset:ip:`, `reset:email:`. Email keys are lowercased.
- Successful responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining` for the first policy; a 429 carries `Retry-After` (seconds) plus `X-RateLimit-Reset` (epoch seconds).
- **Per process.** N instances behind a load balancer means N× the limit, and a deploy resets every window. Abuse damping, not a security control, until a shared store lands.
- Anything keyed by IP depends on `TRUST_PROXY_HEADERS`. Without it there is no client address, so every per-IP policy is **skipped** (one warning per process) rather than shared. Per-email/user/key policies still run. Production must set the variable or it runs with no per-IP limiting. Use `ipRateLimitKey(prefix, ip)` from `src/lib/security/client-ip.ts` to build the key: `null` means skip.

## API keys

`src/lib/api/api-key.ts` + `serviceHandler`. For machine-to-machine callers only: cron jobs, webhook senders, internal services.

- Never on a browser-facing endpoint. A key the browser holds ships in the bundle and protects nothing; operator-facing routes use the Cognito token plus the RBAC check, which is strictly stronger.
- `API_KEYS` is comma-separated so two keys can be live during a rotation. Entries shorter than 32 chars are ignored. No usable key configured means every service request gets a 503 `api_keys_not_configured` — it fails closed on purpose.
- Callers send `x-api-key: <key>` or `Authorization: ApiKey <key>`. Comparison is `timingSafeEqual` over SHA-256 digests.
- `fn` receives `(request, ctx, { keyId })`. `keyId` is the first 8 hex chars of the key's digest: log that, never the key.
- A `serviceHandler` route must be added to `PUBLIC_API_PATHS` in `src/proxy.ts`: the proxy 401s a credential-less `/api/*` request before the handler runs, and it only recognises Cognito cookies or an `Authorization` header.

## Security headers and proxies

- Baseline headers come from `headers()` in `next.config.ts` for every path: `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, plus HSTS in production. `poweredByHeader` is off. There is no CSP yet — Ant Design's inline styles need nonce wiring first.
- `TRUST_PROXY_HEADERS=true` (or `1`) makes `src/lib/security/client-ip.ts` believe `X-Forwarded-For` / `X-Real-IP`, and `src/lib/api/auth.ts` believe `X-Forwarded-Host` for the CSRF origin check. Set it only when exactly one trusted proxy sits in front of the app. `X-Forwarded-For` is read from the **last** entry, because ALB and CloudFront append rather than overwrite. Unset, `clientIpFrom` returns `"unknown"` and per-IP limiting is off.
- An IP is a rate-limit key, not an audit field: do not log or store it. Audit rows go to `admin_permission_audit_events` and record the actor's `admin_users.id`, not their address.
