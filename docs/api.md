# API

The backend is Next.js Route Handlers under `src/app/api/`. There is no other
server. Every endpoint is also listed, with live usage counters, on the
**Services** page of the console.

## Contract

- **Envelope.** Success: `{ "data": … }`. Failure:
  `{ "error": { "code", "message", "details"? } }`. Branch on which key is
  present.
- **Codes** (stable; renaming one is a breaking change): `bad_request` 400,
  `unauthorized` 401, `token_expired` 401 (refresh and retry), `refresh_failed`
  401 (sign in again), `invalid_api_key` 401, `forbidden` 403, `csrf_rejected`
  403, `not_found` 404, `conflict` 409, `validation_failed` 422 (`details` =
  flattened zod issues), `rate_limited` 429, `auth_unavailable` 503,
  `endpoint_disabled` 503, `admin_schema_missing` 503, `database_unavailable`
  503, `internal_error` 500.
- **Headers.** Every response: `Cache-Control: no-store` and `x-request-id`
  (echoed from the request when present; quote it when reporting a problem).
  Successful responses carry `X-RateLimit-Limit` / `-Remaining` for the first
  per-IP policy; a 429 carries `Retry-After` and `X-RateLimit-Reset`.
- **Credentials.** Operator endpoints accept the `psa_id_token` cookie (the
  browser) or `Authorization: Bearer <id token>`. Cookie-authenticated writes
  must pass a same-origin check (`Sec-Fetch-Site`, else `Origin` vs `Host`).
- **Input.** Bodies are JSON, capped at 1 MiB, validated with zod. Query
  strings are validated the same way.

## Rate limits

In-process sliding windows, per preset name (`src/lib/security/rate-limit.ts`):

| Preset | Limit | Applies to |
| --- | --- | --- |
| `api` | 120 / minute per IP, and again per user | operator and session endpoints |
| `authLogin` | 10 / 15 min per IP | sign-in |
| `authLoginAccount` | 5 / 15 min per email | sign-in |
| `authReset` | 5 / 15 min | password reset |
| `authRefresh` | 30 / 15 min per IP | refresh and logout |
| `health` | 30 / minute per IP | the health probe |
| `service` | 600 / minute per key | machine clients (`API_KEYS`), none yet |

Per-IP policies are skipped when the client IP is unknown
(`TRUST_PROXY_HEADERS` unset). Counters live in the Node process: N instances
mean N× the limit, and a restart resets them.

## Endpoints

Keys are what routes declare and what the access map and usage counters use.

### Public

| Key | Route | Purpose |
| --- | --- | --- |
| `health` | `GET /api/health` | Probes both databases. `{ status, db, adminDb, timestamp }`; 503 `database_unavailable` when either is down. |
| `auth.refresh.post` | `POST /api/auth/refresh` | Spends the refresh cookie; `{ expiresIn, userId, email }`. |
| `auth.refresh.get` | `GET /api/auth/refresh?next=` | Same for a navigation; 303 back to `next` or to `/login`. |
| `auth.logout.post` | `POST /api/auth/logout` | Revokes and clears; 303 for a form, 204 for a fetch. |
| `auth.logout.get` | `GET /api/auth/logout` | Same for a navigation. |

### Session

| Key | Route | Purpose |
| --- | --- | --- |
| `me` | `GET /api/v1/me` | The Cognito identity from the token. Does not consult the allowlist. |

### Operator (allowlist + access-map rule)

Default rules as seeded; all editable on the Access Map.

| Key | Route | Purpose | Default rule |
| --- | --- | --- | --- |
| `admin.me` | `GET /api/v1/admin/me` | Caller's capabilities: id, email, super-admin flag, actions. | any operator |
| `admin.users.list` | `GET /api/v1/admin/users` | All admin users with role keys. | `can_manage_admin_users` |
| `admin.users.create` | `POST /api/v1/admin/users` | Invite: `{ email, displayName?, roleKeys, isSuperAdmin }`. | super-admin |
| `admin.users.get` | `GET /api/v1/admin/users/[id]` | One admin user. | `can_manage_admin_users` |
| `admin.users.update` | `PATCH /api/v1/admin/users/[id]` | Any of `displayName`, `roleKeys`, `isSuperAdmin`, `disabled`. | super-admin |
| `admin.roles.list` | `GET /api/v1/admin/roles` | Roles with grants and member counts. | `can_manage_roles` |
| `admin.roles.create` | `POST /api/v1/admin/roles` | `{ key, name, description?, actionKeys }`. | super-admin |
| `admin.roles.get` | `GET /api/v1/admin/roles/[id]` | One role. | `can_manage_roles` |
| `admin.roles.update` | `PATCH /api/v1/admin/roles/[id]` | Any of `name`, `description`, `actionKeys`. | super-admin |
| `admin.roles.delete` | `DELETE /api/v1/admin/roles/[id]` | Non-system, no members. 204. | super-admin |
| `admin.actions.list` | `GET /api/v1/admin/actions` | The permission catalog. | `can_manage_roles` or `can_manage_access_map` |
| `admin.audit.list` | `GET /api/v1/admin/audit?limit=&cursor=` | Audit events, newest first; `nextCursor` pages. | `can_read_admin_audit` |
| `admin.pages.list` | `GET /api/v1/admin/pages` | Page and quick-action rules merged with the registry. | `can_manage_access_map` |
| `admin.pages.upsert` | `PUT /api/v1/admin/pages/[key]` | Register or update a page rule. Empty body = defaults. | super-admin |
| `admin.endpoints.list` | `GET /api/v1/admin/endpoints` | Endpoint rules merged with the registry. | `can_manage_access_map` or `can_read_services` |
| `admin.endpoints.upsert` | `PUT /api/v1/admin/endpoints/[key]` | Register or update an endpoint rule. | super-admin |
| `admin.usage.list` | `GET /api/v1/admin/usage` | 30-day counters per endpoint plus the rate-limit presets. | `can_read_services` |

## Calling from the browser

Use `apiFetch` from `src/lib/api/client.ts` (or the typed wrappers in
`src/lib/admin-access/client.ts`). It attaches credentials, unwraps `data`,
throws `ApiClientError` with the code, and handles `token_expired`.

## Writing a new endpoint

```ts
export const GET = adminHandler(
  async (request, ctx, principal) => ok(await something(principal)),
  { endpoint: "admin.things.list" },
);
```

Then add `admin.things.list` to `src/lib/admin-access/endpoint-registry.ts`
and register it on the Access Map. See
[access-control.md](./access-control.md#adding-a-page-or-endpoint).
