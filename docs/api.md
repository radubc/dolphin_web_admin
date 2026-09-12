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
  `endpoint_disabled` 503, `admin_schema_missing` 503, `defaults_unavailable`
  503 (the defaults a consumer pulls are not seeded), `database_unavailable`
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
| `service` | 600 / minute per key | machine clients (`API_KEYS`): the two service lookups |

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
| `admin.constants.list` | `GET /api/v1/admin/constants/[kind]?page=&pageSize=&q=&state=&country=` | One **page** of a catalog, each row labelled from the sync ledger, with catalog counts, `lastComparedAt` and `latestJob`. `country` (exact match) and the preferred-markets-first order apply to `stocks` and `etfs` only; see constants.md. | `can_read_catalogs` or `can_write_catalogs` |
| `admin.constants.create` | `POST /api/v1/admin/constants/[kind]` | Adds a row to the admin catalog. 201. | `can_write_catalogs` |
| `admin.constants.get` | `GET /api/v1/admin/constants/[kind]/[id]` | One catalog row with its push state. | `can_read_catalogs` or `can_write_catalogs` |
| `admin.constants.update` | `PATCH /api/v1/admin/constants/[kind]/[id]` | Partial edit; at least one field. | `can_write_catalogs` |
| `admin.constants.delete` | `DELETE /api/v1/admin/constants/[kind]/[id]` | Retires a category, account type or market, removes the other kinds. 204. | `can_write_catalogs` |
| `admin.constants.push` | `POST /api/v1/admin/constants/[kind]/push` | Upserts into the main app database. Body: exactly one of `{ ids }` or `{ scope }`. Answers `{ job }`. 409 for `categories` and `financial_institutions`, which the consumer app pulls. | `can_write_catalogs` |
| `admin.constants.compare` | `POST /api/v1/admin/constants/[kind]/compare` | Rebuilds the catalog's sync ledger against the main app database. No body. Answers `{ job }`. 409 for `categories` and `financial_institutions`. | `can_write_catalogs` |
| `admin.constants.jobs.list` | `GET /api/v1/admin/constants/[kind]/jobs?limit=` | Recent compare and push jobs, newest first. `limit` 1..50, default 10. | `can_read_catalogs` or `can_write_catalogs` |
| `admin.constants.jobs.get` | `GET /api/v1/admin/constants/[kind]/jobs/[jobId]` | One job, for polling. Non-uuid or another catalog's job is a 404. | `can_read_catalogs` or `can_write_catalogs` |
| `admin.integrations.list` | `GET /api/v1/admin/integrations` | Every integration with schedule, settings, `apiKeyConfigured` (presence only) and `latestRun`, plus `schedulerActive`. | `can_read_integrations` or `can_write_integrations` |
| `admin.integrations.update` | `PATCH /api/v1/admin/integrations/[key]` | Any of `baseUrl` (https), `isEnabled`, `schedule`, `settings`. Recomputes `nextRunAt`. | `can_write_integrations` |
| `admin.integrations.run` | `POST /api/v1/admin/integrations/[key]/run` | Starts a run. Body `{ force? }`, empty allowed. Answers a `running` run. | `can_write_integrations` |
| `admin.integrations.runs.list` | `GET /api/v1/admin/integrations/[key]/runs?limit=` | Recent runs, newest first. `limit` 1..50, default 10. | `can_read_integrations` or `can_write_integrations` |
| `admin.integrations.runs.get` | `GET /api/v1/admin/integrations/[key]/runs/[runId]` | One run, for polling. Non-uuid or another integration's run is a 404. | `can_read_integrations` or `can_write_integrations` |
| `admin.integrations.quote_symbols.list` | `GET /api/v1/admin/integrations/quote-symbols?page=&pageSize=&q=&kind=&active=` | One page of the quote watch list, each item with `latestQuote`. | `can_read_integrations` or `can_write_integrations` |
| `admin.integrations.quote_symbols.create` | `POST /api/v1/admin/integrations/quote-symbols` | `{ kind, symbol, exchange? }`. 201. 409 on a duplicate canonical. | `can_write_integrations` |
| `admin.integrations.quote_symbols.update` | `PATCH /api/v1/admin/integrations/quote-symbols/[id]` | `{ isActive }`. | `can_write_integrations` |
| `admin.integrations.quote_symbols.delete` | `DELETE /api/v1/admin/integrations/quote-symbols/[id]` | Removes the watch row; cached quotes stay. 204. | `can_write_integrations` |
| `admin.integrations.currency_pairs.list` | `GET /api/v1/admin/integrations/currency-pairs?page=&pageSize=&q=&active=` | One page of the pair watch list, each item with `latestRate`. | `can_read_integrations` or `can_write_integrations` |
| `admin.integrations.currency_pairs.create` | `POST /api/v1/admin/integrations/currency-pairs` | `{ fromCurrency, toCurrency }`, three letters each, must differ. 201; 409 on a duplicate. | `can_write_integrations` |
| `admin.integrations.currency_pairs.update` | `PATCH /api/v1/admin/integrations/currency-pairs/[id]` | `{ isActive }`. | `can_write_integrations` |
| `admin.integrations.currency_pairs.delete` | `DELETE /api/v1/admin/integrations/currency-pairs/[id]` | Removes the watch row; cached rates stay. 204. | `can_write_integrations` |
| `admin.customers.list` | `GET /api/v1/admin/customers?page=&pageSize=&q=&status=&includeDeleted=` | One page of the consumer app's users, each with tenants, `lastActiveAt`, `accountCount`, `transactionCount`, the pool account and a derived `status`, plus header `counts` and `cognitoAvailable`. `q` matches email and tenant name. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.customers.get` | `GET /api/v1/admin/customers/[id]` | One customer by `users.id`. 404 when there is no such row. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.customers.invites.list` | `GET /api/v1/admin/customers/invites?page=&pageSize=&q=&status=` | Invitations, newest first, with `counts` per status, `canSend` and `unavailableReason`. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.customers.invites.create` | `POST /api/v1/admin/customers/invites` | `{ email, note?, name?, locale? }`. `name` and `locale` are sent to the pool as the `name` / `locale` attributes (`locale` a BCP 47 tag, e.g. `en-CA`); the pool requires both, and whichever is left blank the person supplies at first sign-in. Creates the customer-pool account and sends the email. 201. 409 when the address has an account or an open invitation; 422 when Cognito refuses the address; 503 `cognito_unavailable` when the pool or the AWS credentials are missing. | `can_invite_users` |
| `admin.customers.invites.resend` | `POST /api/v1/admin/customers/invites/[id]/resend` | No body. Re-issues the temporary password and bumps `sendCount`. 409 unless the invitation is still open. | `can_invite_users` |
| `admin.customers.invites.revoke` | `DELETE /api/v1/admin/customers/invites/[id]` | Deletes the unused pool account and marks the invitation `revoked`. Answers the updated invitation, not 204. 409 once the person has signed in. | `can_invite_users` |

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

**Two kinds are pulled, not pushed.** `categories` and `financial_institutions`
answer `admin.constants.push` and `admin.constants.compare` with 409 `conflict`
("… are pulled by the consumer app at tenant creation; there is nothing to
push"). The consumer app fetches those defaults itself, from the two
`service.defaults.*` endpoints below, when it creates a tenant. Everything else
about the two kinds is unchanged: list, get, create, update, delete and the job
endpoints work exactly as for any other catalog, and the Constants page is now
their only home. The other eight kinds keep compare and push in full.

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

### Service (API key)

Machine-to-machine only, for the consumer app. The caller sends
`x-api-key: <key>` or `Authorization: ApiKey <key>` (`API_KEYS`,
comma-separated, 32 characters minimum); no key configured is a 503
`api_keys_not_configured`. Every path is listed in `PUBLIC_API_PATHS` in
`src/proxy.ts` so the proxy does not refuse them for having no Cognito cookie,
and none consults the access map: the key is the credential.

| Key | Route | Purpose |
| --- | --- | --- |
| `service.quotes.lookup` | `GET /api/v1/service/quotes?symbols=AAPL,SHOP:TSX,BTC/USD` | `{ quotes, missing }`. Newest cached quote per symbol; symbols with nothing from today are fetched from TwelveData, **at most one batch inline** (see below). Up to 100 symbols. |
| `service.exchange_rates.lookup` | `GET /api/v1/service/exchange-rates?pairs=USD/CAD,EUR/USD` | `{ rates, missing }`. Newest cached rate per pair; fetches the Bank of Canada only when today's series are not cached, in one call for every pair. Up to 100 pairs. |
| `service.defaults.categories` | `GET /api/v1/service/defaults/categories` | `{ categories: [{ id, name, type, parentId, isDiscretionary }] }`. Every live admin category (`deleted_at IS NULL`), ordered by `created_at` then `id`. No query string. |
| `service.defaults.financial_institutions` | `GET /api/v1/service/defaults/financial-institutions` | `{ financialInstitutions: [{ id, name, institutionNumber, type }] }`. The whole admin catalog, ordered by `name` then `id`. No query string. |

**The defaults are pulled, not pushed.** The consumer app calls the two
`defaults` endpoints when it creates a tenant and copies the rows into that
tenant's own categories and institutions; the admin catalog on the Constants
page is the single source of them, and neither is written to the main app
database any more (`admin.constants.push` refuses both kinds with a 409).
`type` on a category is passed through exactly as stored — `Inflow`, `Outflow`
or `null` — for the consumer to copy into its own column unchanged, and
`parentId` refers to another id in the same payload. `created_at` order is not
a parent-before-child order, so a consumer inserting the tree needs two passes
or a deferred foreign key.

**Unlike the quote and rate lookups these two fail loudly.** A tenant created
with no categories is broken, so an empty answer is never sent: an admin schema
that is not installed is a 503 `admin_schema_missing` and a catalog with zero
rows a 503 `defaults_unavailable` ("The admin catalog has no categories; seed it
on the Constants page"). The caller should abandon the tenant creation and
retry, not carry on.

**The consumer app bounds what it accepts.** It validates the payload before
copying a single row: at most 5,000 rows per catalog and, on every row, a
`name` of at most 255 characters (`src/lib/admin-service/client.ts` in the
consumer app). A catalog past either limit fails tenant creation the same way
an unreachable admin console would, so keep both catalogs under 5,000 live
rows and every name to 255 characters or fewer.

**One batch inline, the rest in the background.** A quote lookup spends at
most `settings.batchSize` credits (one TwelveData call) while the caller waits.
When more symbols than that are stale, the remainder is handed to a background
`on_demand` run and answered from the newest cached value, or reported
`pending` when there is nothing cached; asking again a little later gets the
fetched values. Without that rule a request for 100 stale symbols on the free
plan (8 credits a minute) would hold the connection open for a quarter of an
hour. Rates need no equivalent: one Bank of Canada call covers every pair.

**Neither ever fails because a provider does.** A dead provider, a missing API
key, a disabled integration or an uninstalled schema all answer 200 with
whatever the cache holds, and list the rest in `missing` with a reason
(`not_found` — the provider does not have it; `provider_error` — try again
later; `unavailable` — the integration is off or unconfigured, or an operator
deactivated that symbol or pair on the watch list; `pending` — a fetch has been
started, ask again shortly). A symbol or pair that was not on a watch list is
added to it (`source: "request"`) **after** the provider answered for it, so a
typo'd ticker never buys a daily credit; an item an operator deactivated is
never fetched for and never reactivated by a lookup.

## Integrations semantics

`[key]` is one of `twelvedata_catalogs`, `iso_mic_markets`,
`twelvedata_quotes`, `alpha_vantage_quotes`, `bank_of_canada_rates`; any other
value is a 404 `not_found`. The rows are seeded by
[`docs/sql/008_integrations.sql`](./sql/008_integrations.sql) and
[`009_markets_and_alpha_vantage.sql`](./sql/009_markets_and_alpha_vantage.sql)
and cannot be created or deleted through the API — only their base URL, enabled
flag, schedule and settings can change. The base URL has to stay on the
provider's own domain (`twelvedata.com`, `bankofcanada.ca`, `iso20022.org` or
`alphavantage.co`, subdomains included); anything else is a 422
`validation_failed` naming the domain, because the quote calls carry an API
key — and Alpha Vantage's travels in the query string, so its address is the
one an operator could most directly turn into a leak. Saving recomputes `nextRunAt` only when the
schedule or the enabled flag changed, so editing a base URL cannot postpone a
run that is already due.

**Runs.** `admin.integrations.run` answers a `running` run, which the page
follows through the two run endpoints; nothing runs inline, because a catalog
download moves hundreds of thousands of rows and a quote run paces itself
against a per-minute credit allowance. Only one run per integration is live at
a time, so a second request is a 409 `conflict` naming the run that holds it.
An integration whose API key is not configured is refused with 422
`validation_failed` naming the environment variable, rather than starting a run
that could only fail. A run that is `running` with a stale heartbeat is
reported as `interrupted` — every batch commits on its own, so nothing already
written is lost and it can simply be started again.

**Scheduling.** A 60-second in-process tick (`src/instrumentation.ts`, switched
off with `INTEGRATIONS_SCHEDULER=off`) starts the integrations whose
`nextRunAt` has passed, claiming each with an atomic update so two instances
never both run one. `schedulerActive` on the list response says whether this
process is the one doing it.

**Never the main app database.** Everything this feature reads and writes is in
the admin database. Rows the catalog download inserts are marked `new` in the
Constants sync ledger, so they reach the consumer app the same way every other
catalog row does: through a Constants push.

Until [`docs/sql/008_integrations.sql`](./sql/008_integrations.sql) has run,
the operator endpoints answer 503 `admin_schema_missing`. Full details in
[integrations.md](./integrations.md).

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
