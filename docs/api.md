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
| `admin.constants.list` | `GET /api/v1/admin/constants/[kind]?page=&pageSize=&q=&state=` | One **page** of a catalog, each row labelled from the sync ledger, with catalog counts, `lastComparedAt` and `latestJob`. | `can_read_catalogs` or `can_write_catalogs` |
| `admin.constants.create` | `POST /api/v1/admin/constants/[kind]` | Adds a row to the admin catalog. 201. | `can_write_catalogs` |
| `admin.constants.get` | `GET /api/v1/admin/constants/[kind]/[id]` | One catalog row with its push state. | `can_read_catalogs` or `can_write_catalogs` |
| `admin.constants.update` | `PATCH /api/v1/admin/constants/[kind]/[id]` | Partial edit; at least one field. | `can_write_catalogs` |
| `admin.constants.delete` | `DELETE /api/v1/admin/constants/[kind]/[id]` | Retires a category, account type or market, removes the other kinds. 204. | `can_write_catalogs` |
| `admin.constants.push` | `POST /api/v1/admin/constants/[kind]/push` | Upserts into the main app database. Body: exactly one of `{ ids }` or `{ scope }`. Answers `{ job }`. | `can_write_catalogs` |
| `admin.constants.compare` | `POST /api/v1/admin/constants/[kind]/compare` | Rebuilds the catalog's sync ledger against the main app database. No body. Answers `{ job }`. | `can_write_catalogs` |
| `admin.constants.jobs.list` | `GET /api/v1/admin/constants/[kind]/jobs?limit=` | Recent compare and push jobs, newest first. `limit` 1..50, default 10. | `can_read_catalogs` or `can_write_catalogs` |
| `admin.constants.jobs.get` | `GET /api/v1/admin/constants/[kind]/jobs/[jobId]` | One job, for polling. Non-uuid or another catalog's job is a 404. | `can_read_catalogs` or `can_write_catalogs` |

`[kind]` is one of `countries`, `currencies`, `financial_institutions`,
`categories`, `account_base_types`, `account_types`, `cryptocurrencies`,
`etfs`, `stocks`, `markets`; any other value is a 404 `not_found`.

`[id]` is always a string. `cryptocurrencies`, `etfs` and `stocks` are keyed by
an integer sequence rather than a UUID, so their ids are the decimal form of
that integer; anything else in the segment is a 404 `not_found`, never a
malformed query.

**Listing.** `admin.constants.list` answers one page and never compares the
two databases: `page` (1-based, default 1), `pageSize` (default 50, clamped to
200), `q` (case-insensitive substring over the kind's searchable columns) and
`state` (`all` — the default, every live row — one of `new` / `changed` /
`synced` / `unknown`, `pending` for new + changed, or `retired`). The body is
`{ kind, rows, page, pageSize, total, counts, lastComparedAt, latestJob }`,
where `total` counts the rows matching the query and `counts` describes the
whole catalog (`total`, `new`, `changed`, `synced`, `unknown`, `retired`,
`mainOnly`). Each row's `pushState` comes from the sync ledger; a row nothing
has compared is `unknown`.

**Push and compare semantics.** `admin.constants.push` is the only endpoint
that writes to the main app database. Its body is exactly one of
`{ "ids": [...] }` (1..5000 rows), `{ "scope": "pending" }` (everything the
ledger calls new or changed) or `{ "scope": "all" }`; both or neither is a 422,
as is an empty `ids` array, and an unknown id is a 404 with nothing pushed. It
**upserts by id** in batches of 1000, one transaction per batch, and **never
deletes** there — rows are referenced by tenant data, so removal stays a
deliberate act on the consumer side. Dependencies are written first, per batch
(a country's currency, an account type's base type, a category's ancestors);
the four market-data catalogs reference nothing and never carry any. A push
into one of the integer-keyed `preload_*` tables also advances that table's
sequence, so the consumer app cannot be handed an id the push just took.

Both endpoints answer `{ "job": … }`. A push of at most 200 rows and a compare
of a catalog of at most 5000 rows run **inline**, so the job comes back
`succeeded` or `failed`; anything larger comes back `running` and is followed
through the jobs endpoints. A job that is `running` with a stale heartbeat is
reported as `interrupted` — rerun it. Only one compare or push runs per catalog
at a time; a second request is a 409 `conflict` naming the job that holds it.
Until [`docs/sql/007_constants_sync_and_jobs.sql`](./sql/007_constants_sync_and_jobs.sql)
has run, all of these answer 503 `admin_schema_missing`. Full details in
[constants.md](./constants.md).

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
