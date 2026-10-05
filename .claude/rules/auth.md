---
paths:
  - "src/lib/auth/**"
  - "src/app/api/auth/**"
  - "src/app/login/**"
  - "src/proxy.ts"
---

# Session, token refresh, and admin authorization

**Status:** `src/lib/auth/`, `src/app/api/auth/`, `src/app/login/`, `src/app/forgot-password/` and `src/proxy.ts` are ported from `../penny-squeeze-web` with the `psa_` cookie prefix and the `ADMIN_COGNITO_*` variables. The allowlist and access-map checks live in `src/lib/admin-access/authorize.ts`: the layout calls `requireAdminSession()`, every page calls `requirePageAccess("<key>")`, routes use `adminHandler(fn, { endpoint })`. Rules come from the admin database (`docs/access-control.md`); the Prisma repository is the default and `ADMIN_ACCESS_STORE=mock` selects the in-memory mock. Do not redesign the session model.

## Admin differences from the consumer app

- **Separate Cognito user pool.** Tokens are verified against the admin-only pool (`ADMIN_COGNITO_*` variables, see `CLAUDE.md`). A token from the end-user pool must fail verification, never fall through.
- **Authentication is not authorization.** A valid token only proves who the caller is. Before a session is created, and again on every request, look the `sub` up in `admin_users` (admin database). No row, or `disabled_at` set, means no session and a 403 `forbidden`. Every route and UI control then requires an explicit action key unless the user is `is_super_admin`. Rules and the seed catalog are in `docs/admin-access/README.md`.
- **Different cookie prefix.** Use `psa_` (`psa_id_token`, `psa_access_token`, `psa_session`, `psa_refresh_token`, `psa_refresh_proof`), not the consumer app's `ps_`. Browsers do not scope cookies by port, so on `localhost` the admin app (3001) and the consumer app (3000) share a cookie jar; identical names would let one app's session clobber the other's.
- **Same session policy as the consumer app** (owner, 2026-09-15): signed out after 30 idle minutes, never while working, absolute cap the refresh token's validity (1 day once the pool is updated). Re-check the allowlist and roles from the database on every request so a revocation lands within one request, not one token lifetime.
- **Audit.** Every grant, revoke, enable, or disable of an admin user writes an `admin_permission_audit_events` row with the actor's `admin_users.id`.

## Session cookies

Policy (`docs/auth.md`, "Session lifetime"): a browser is signed out after **30 minutes without activity** (`IDLE_TIMEOUT_SECONDS` in `cookies.ts`) and never while the operator keeps working. Cognito has no idle timeout and rotation does not extend a refresh token, so the sliding window is enforced here. Six httpOnly cookies, across two paths, every lifetime derived from the token's own `exp`:

| Cookie | Path | Lifetime | Contents |
| --- | --- | --- | --- |
| `psa_id_token` | `/` | its `exp - 60s` | the id token, the only credential that proves identity |
| `psa_access_token` | `/` | its `exp - 60s` | the access token, spent only on Cognito self-service calls |
| `psa_session` | `/` | id `exp` + 30 min | `"1"`, no secret: tells the proxy a refresh token exists |
| `psa_refresh_token` | `/api/auth` | id `exp` + 30 min | the refresh token |
| `psa_refresh_proof` | `/api/auth` | id `exp` + 30 min | the id token issued with it: the tamper-proof "last activity" clock the refresh endpoint checks |
| `psa_sign_in_method` | `/` | id `exp` + 30 min | how the session was signed in (`password`, `password+totp`, `passkey`), HMAC-bound to the id token's `sub` and `origin_jti`; unverifiable → `password` (`src/lib/auth/sign-in-method.ts`, since 2026-10-04) |

`psa_refresh_user` is no longer written (the refresh call needs no username); it stays in `SESSION_COOKIES` so legacy copies are deleted.

- The refresh token is path-scoped because it is the most valuable credential in the set: it must reach `/api/auth/refresh` and `/api/auth/logout` and nothing else. The proxy cannot see it, which is what `psa_session` is for.
- The id/access cookies expire a minute *before* their JWTs, so "no id cookie" is the single signal that a refresh is due.
- Refresh is `GetTokensFromRefreshToken` (`refreshTokens()` in `cognito.ts`): `ClientSecret` goes in the request as is, no SECRET_HASH and no username. It works with rotation on or off; a new refresh token comes back only with rotation on, and `createSession(tokens, currentRefreshToken)` re-sets the one on file otherwise so the window slides.
- Before spending a Cognito call, `refreshSession()` verifies `psa_refresh_proof` with `graceSeconds: IDLE_TIMEOUT_SECONDS`: too old ⇒ outcome `idle` (`proof: "stale"`) — the refresh token is revoked, every cookie cleared, `POST` answers 401 `session_idle`, `GET` redirects to `/login?session=idle` (the login page shows the notice; the proxy passes that query through); a *missing* proof (a session from before this design) is `proof: "missing"` — same revoke and clear, but `refresh_failed` / plain `/login`, because nobody was idle. On a `cross-site` GET the verdict is reported but nothing is revoked or cleared (`endIdleSession: false`); the next same-site request does it. The `no_refresh_token` check stays ahead of it so a cookie-less cross-site POST cannot force a sign-out.
- `SessionKeepalive` (`src/components/auth/session-keepalive.tsx`, mounted in the `(app)` layout) records activity across tabs in `localStorage`, refreshes 120 s before the id token expires (15 s tick; one tab at a time via a 45 s `psa:refresh-lock`, the expiry shared as `psa:id-expires-at`) while the operator is active — so Server Action POSTs never bounce — and, after 30 idle minutes, awaits `POST /api/auth/logout` (5 s cap) before going to `/login?session=idle`, or to `/login?session=expired` when that call failed. Without `localStorage` it goes passive: it stops renewing and never signs out on its own.
- `psa_session`, `psa_refresh_token` and `psa_refresh_proof` are always written together with the same lifetime, so the marker can never outlive the token it advertises. If a marker is ever stale anyway, `GET /api/auth/refresh` clears the path-`/` cookies (`clearPageSession()`) on a non-`cross-site` request, so the next navigation goes to `/login` instead of looping.

## The two refresh flows

- **Pages.** The proxy sees no id cookie but a `psa_session` marker on a GET and sends a 307 to `/api/auth/refresh?next=<path>`. That handler refreshes and 303s back. `next` is validated as a relative same-origin path that is not under `/api/`.
- **Fetch clients.** `authenticate()` answers a stale cookie session with 401 `token_expired`. `apiFetch()` (`src/lib/api/client.ts`) POSTs `/api/auth/refresh` once, retries the original request once, and on failure sends the browser to `/login`. `refresh_failed` (401) means the refresh token itself is gone: sign in again.

The `GET` limits itself (`rateLimit: null` plus an inline `RATE_LIMITS.authRefresh`) so an over-budget navigation gets a 303 to `/login` rather than JSON; the `POST` keeps the wrapper's option and its JSON 429.

`verifySession()` never refreshes. Render-time code cannot set cookies, so refreshing is a Route Handler's job — `refreshSession()` must only be called from a Route Handler or Server Action. A refreshed session still re-runs the `admin_users` lookup.

A Cognito outage returns 503 `auth_unavailable` and leaves every cookie alone. Only a verdict from Cognito that the refresh token is dead clears the session.

## Logout

Sign-out has to *arrive* at `/api/auth/logout` as a real browser request: that path is the only place the refresh cookie is readable, and revoking it at Cognito is the whole point. So the sign-out control is a plain HTML form — `<form action={LOGOUT_PATH} method="post">` — not a Server Action.

The route tells the two callers apart: `Sec-Fetch-Mode: navigate` (or an `Accept` containing `text/html`) means a form submission and gets a 303 to `/login`; anything else is a `fetch` and gets 204. Both revoke the token, clear every cookie, and refuse a `cross-site` request.

`logout()` in `src/lib/auth/actions.ts` is the JS-free fallback: `clearSession()` then `redirect("/login")`.

## Cross-site protection

Cookie-authenticated writes go through `assertSameOrigin()`: `Sec-Fetch-Site` must be `same-origin`/`none`, or failing that `Origin` must match the request host. Otherwise 403 `csrf_rejected`. Bearer-token callers are exempt.

## Cognito app client settings this depends on

Admin pool only, public sign-up disabled. `ALLOW_USER_PASSWORD_AUTH` (and `ALLOW_USER_AUTH` for passkeys) in the explicit auth flows, token revocation enabled. `ALLOW_REFRESH_TOKEN_AUTH` is not needed and must be *removed* once refresh-token rotation is on (rotation refuses that flow). Target settings, applied after deploy from the consumer repo's `docs/cognito/README.md`: id token 5 min, access token 15 min, refresh token 1 day, rotation on with a 60 s grace. The code works with today's settings too (60-minute tokens, no rotation, 30-day refresh). `SESSION_COOKIES` must never list the same name twice; cookie deletion is keyed by name only.
