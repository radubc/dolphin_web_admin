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
| `admin.me.password.change` | `POST /api/v1/admin/me/password` | Changes the caller's own password (Cognito `ChangePassword` with the caller's access token). Per-operator and per-IP `authReset` budget. | any operator |
| `admin.me.mfa.get` | `GET /api/v1/admin/me/mfa` | Whether an authenticator app is on for the caller. | any operator |
| `admin.me.mfa.totp.start` | `POST /api/v1/admin/me/mfa/totp` | Starts authenticator enrolment: the secret and `otpauth://` URI. 503 `mfa_not_enabled` until the pool allows software-token MFA. | any operator |
| `admin.me.mfa.totp.verify` | `PUT /api/v1/admin/me/mfa/totp` | Verifies the first code and turns the authenticator on. | any operator |
| `admin.me.mfa.totp.disable` | `DELETE /api/v1/admin/me/mfa/totp` | Turns the authenticator off. | any operator |
| `admin.me.passkeys.list` | `GET /api/v1/admin/me/passkeys` | The caller's registered passkeys. 503 `passkeys_not_enabled` until the pool has a WebAuthn relying party. | any operator |
| `admin.me.passkeys.start` | `POST /api/v1/admin/me/passkeys` | Starts a passkey registration: the WebAuthn creation options. | any operator |
| `admin.me.passkeys.complete` | `PUT /api/v1/admin/me/passkeys` | Completes it with the authenticator's credential. | any operator |
| `admin.me.passkeys.delete` | `DELETE /api/v1/admin/me/passkeys/[id]` | Removes one passkey. | any operator |
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
| `admin.integrations.currency_pairs.create` | `POST /api/v1/admin/integrations/currency-pairs` | `{ fromCurrency, toCurrency }`, three letters each, must differ. 201 `{ pair, history }` — the watch row **and** the six months of history the add fetches for it (see below); 409 on a duplicate. | `can_write_integrations` |
| `admin.integrations.currency_pairs.update` | `PATCH /api/v1/admin/integrations/currency-pairs/[id]` | `{ isActive }`. | `can_write_integrations` |
| `admin.integrations.currency_pairs.delete` | `DELETE /api/v1/admin/integrations/currency-pairs/[id]` | Removes the watch row; cached rates stay. 204. | `can_write_integrations` |
| `admin.integrations.currency_pairs.rates` | `GET /api/v1/admin/integrations/currency-pairs/[id]/rates?page=&pageSize=` | One page of the pair's download history — `{ items: ExchangeRate[], total, page, pageSize }`, newest observation day first, then newest fetch. `pageSize` 1..200, default 30. Addressed by the watch row's id, so a pair removed from the watch list is a 404 even though its rates are still stored. | `can_read_integrations` or `can_write_integrations` |
| `admin.integrations.currency_pairs.backfill` | `POST /api/v1/admin/integrations/currency-pairs/[id]/backfill` | No body. Fetches the pair's last six months (`today − 182 days` → today) in one ranged Bank of Canada call and stores the days the cache did not have. 200 `{ pair, history }`, the same shape the create endpoint answers; 404 for an unknown id, **409 for an inactive pair**. A provider that is down, disabled or busy is *not* an error — it is a `history.status`. | `can_write_integrations` |
| `admin.customers.list` | `GET /api/v1/admin/customers?page=&pageSize=&q=&status=&includeDeleted=` | One page of the consumer app's users, each with tenants, `lastSeenAt` (the consumer app's sign-in stamp), `lastActiveAt` (the derived fallback), `accountCount`, `transactionCount`, the pool account and a derived `status`, plus header `counts` (now including `deleted`) and `cognitoAvailable`. `q` matches email and tenant name. `status=deleted` selects the soft-deleted rows and implies `includeDeleted`; **every other `status` value excludes them**, whatever `includeDeleted` says — see the note below. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.customers.get` | `GET /api/v1/admin/customers/[id]` | One customer by `users.id`. 404 when there is no such row. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.customers.invites.list` | `GET /api/v1/admin/customers/invites?page=&pageSize=&q=&status=` | Invitations, newest first, with `counts` per status, `canSend` and `unavailableReason`. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.customers.invites.create` | `POST /api/v1/admin/customers/invites` | `{ email, note?, name?, locale? }`. `name` and `locale` are sent to the pool as the `name` / `locale` attributes (`locale` a BCP 47 tag, e.g. `en-CA`); the pool requires both, and whichever is left blank the person supplies at first sign-in. Creates the customer-pool account and sends the email. 201. 409 when the address has an account or an open invitation; 422 when Cognito refuses the address; 503 `cognito_unavailable` when the pool or the AWS credentials are missing. | `can_invite_users` |
| `admin.customers.invites.resend` | `POST /api/v1/admin/customers/invites/[id]/resend` | No body. Re-issues the temporary password and bumps `sendCount`. 409 unless the invitation is still open. | `can_invite_users` |
| `admin.customers.invites.revoke` | `DELETE /api/v1/admin/customers/invites/[id]` | Deletes the unused pool account and marks the invitation `revoked`. Answers the updated invitation, not 204. 409 once the person has signed in. | `can_invite_users` |
| `admin.customers.statistics` | `GET /api/v1/admin/customers/statistics?months=6&days=35` | `{ accounts: { total, byStatus, disabled, snapshotDay }, mau, wau, dau, newPerMonth[], deletedPerMonth[], churnPerMonth[], retentionBySignupMonth[], funnel, poolMetrics[], usage: { requestsPerDay[], errorsPerDay[] }, largestTenants: { byBytes[], byTransactions[] }, months, days, generatedAt }`. `months` 1..24 (default 6) sizes the monthly series, `days` 1..400 (default 35) the two daily ones. Never calls AWS: the pool figures come from the history tables the nightly `cognito_directory` run fills. Its two expensive parts — the monthly churn denominators and the largest-tenant tables — are cached in process for ten minutes; `generatedAt` is still when the whole payload was assembled. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.customers.activity` | `GET /api/v1/admin/customers/[id]/activity` | `{ userId, cognitoSub, email, lastSeenAt, lastActiveAt, createdAt, deletedAt, usage[], tenants[], events[], days }` for one customer: 35 days of their own `usage_daily` counters, the size of each tenant they belong to, and every lifecycle event recorded for their Cognito sub. No query string. 404 when there is no such `users` row. Unlike the statistics endpoint this one answers **before** `docs/sql/014_customer_statistics.sql` has run: everything but `events` comes from the main app database, so a missing `admin_customer_events` gives `events: []` rather than a 503. | `can_read_user_list`, `can_read_user_detail` or `can_invite_users` |
| `admin.costs.summary` | `GET /api/v1/admin/costs` | `{ snapshot, byService, byComponent, lastRun }` from the cached AWS cost tables. No query string. | `can_read_costs` or `can_write_costs` |
| `admin.costs.daily` | `GET /api/v1/admin/costs/daily?days=35` | `[{ day, totalUsd, estimated, services }]`, oldest first, ending yesterday. `days` 1..400, default 35. | `can_read_costs` or `can_write_costs` |
| `admin.costs.per_client` | `GET /api/v1/admin/costs/per-client?month=YYYY-MM` | `{ month, monthTotalUsd, pools: { fixedUsd, storageUsd, requestUsd, userUsd, unallocatedUsd }, tenants: [{ tenantId, tenantName, ownerEmail, totalUsd, fixedUsd, storageUsd, requestUsd, userUsd, sharePct, requests, storageBytes, activeUsers, deleted }], computedAt }`, most expensive first. `month` defaults to the current UTC month and must be between `2020-01` and the month after this one (422 otherwise). An **allocated estimate**, never a bill; reads `admin_tenant_cost_monthly` and never recomputes. **`ownerEmail` is `null` unless the caller also holds `can_read_user_list` or `can_read_user_detail`** — see below. | `can_read_costs` or `can_write_costs` |

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
| `service.exchange_rates.lookup` | `GET /api/v1/service/exchange-rates?pairs=USD/CAD,EUR/USD[&date=YYYY-MM-DD \| &from=YYYY-MM-DD&to=YYYY-MM-DD]` | `{ rates, missing }`. Up to 100 pairs, and one of three forms. **No date:** the newest rate per pair — the pair's own rate if it was fetched today, else the observation this process already fetched today (memoised in `jobs/rates.ts` — computed and written, no provider call), else one Bank of Canada call covering every pair. **`date`:** the closest observation on or before that day, looking back up to 10 calendar days; each rate's own `date` is the real observation day. **`from`+`to`:** every published observation in the window, so `rates` holds one entry per pair *and* day (window at most 400 days; `from ≤ to ≤ today`). `date` and `from`/`to` are mutually exclusive, and `from`/`to` come together — anything else is a 422. Both dated forms are answered from `admin_exchange_rates` when it already covers the window and otherwise by **one** ranged Valet call. Only the requested pairs are ever written. A pair with no observation in the window is `missing` with reason `not_found`. |
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
`twelvedata_quotes`, `alpha_vantage_quotes`, `bank_of_canada_rates`,
`aws_costs`, `cognito_directory`; any other value is a 404 `not_found`. The
rows are seeded by
[`docs/sql/008_integrations.sql`](./sql/008_integrations.sql),
[`009_markets_and_alpha_vantage.sql`](./sql/009_markets_and_alpha_vantage.sql),
[`013_aws_costs.sql`](./sql/013_aws_costs.sql)
and [`014_customer_statistics.sql`](./sql/014_customer_statistics.sql)
and cannot be created or deleted through the API — only their base URL, enabled
flag, schedule and settings can change. The base URL has to stay on the
provider's own domain (`twelvedata.com`, `bankofcanada.ca`, `iso20022.org`,
`alphavantage.co` or `amazonaws.com`, subdomains included); anything else is a 422
`validation_failed` naming the domain, because the quote calls carry an API
key — and Alpha Vantage's travels in the query string, so its address is the
one an operator could most directly turn into a leak. Saving recomputes `nextRunAt` only when the
schedule or the enabled flag changed, so editing a base URL cannot postpone a
run that is already due.

**`aws_costs` is the odd one out.** Its provider is AWS itself, so it carries
no API key (`requiresApiKey` false, `apiKeyEnv` null — the credential is the
ECS task role) and its `baseUrl` is read by nothing: the AWS SDK builds its
own endpoint, pinned to `us-east-1` because Cost Explorer, Budgets and Free
Tier are global services reached there. Its `settings` are `days`,
`componentTag` and `budgetName`, and `force` in a run body means nothing to it
— every run re-fetches and replaces its whole window. Its run counters count
**AWS calls**, not items: `total` is the calls planned, `processed` the calls
that came back, `failed` the calls that refused for a reason worth attention,
and `created` / `updated` are cached rows. Each run spends about $0.03 in Cost
Explorer requests; see [costs.md](./costs.md).

**`cognito_directory` is the other AWS-credential one**, and free. Its
provider is AWS (Cognito and CloudWatch), so it carries no API key either and
its `baseUrl` is likewise read by nothing; its only setting is `metricsDays`
(1..450, default 35), and `force` means nothing to it — every run reads the
whole pool and replaces its whole metrics window. Its counters count **parts
of the run**, not items: `total` is always 4 (snapshot, diff, pool metrics,
the consumer-app deletion sweep), `processed` the parts that finished,
`failed` the parts that refused for a reason worth attention, `created` the
rows written (snapshot rows plus event rows plus new metric days), `updated`
the metric days that replaced an earlier reading, and `unchanged` the accounts
the diff found nothing to say about. A run whose pool listing was cut short by
the page cap **writes the snapshot but refuses the diff** and fails: every
account the listing did not reach would otherwise be recorded as deleted (the
day is marked `partial`, so it is never diffed *against* either). Two more
shapes refuse the diff the same way — an empty listing where the previous
snapshot was not, and a drop of more than half the pool *and* more than 20
accounts — because a `deleted` event is permanent and a wrong
`CUSTOMER_COGNITO_USER_POOL_ID` looks exactly like a mass deletion. The
metrics part fails the run when CloudWatch answers with a `StatusCode` other
than `Complete`, with `Messages`, or with nothing at all for every query while
the pool holds at least one confirmed account. See
[customers.md](./customers.md).

**Customer status precedence.** A customer's `status` is derived on the server
and `deleted` outranks everything the Cognito pool says: a soft-deleted
`users` row (`users.deleted_at`, written by the consumer app's own
delete-my-account flow) is `deleted` whether or not the pool account is still
there, because the clean-up order is an implementation detail and the person
has left either way. The filter follows from that. `?status=deleted` selects
the soft-deleted rows and only those; **any other `?status=` value excludes
them, even with `?includeDeleted=true`** — otherwise `status=active` could
answer with a row whose own `status` field reads `deleted`. `includeDeleted`
is therefore only meaningful on an unfiltered list (`status=all`, the
default). The header `counts.deleted` is unaffected: it counts every
soft-deleted row whatever the filters show.

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

**Currency pair history.** Two endpoints answer
`{ pair: CurrencyPair, history: CurrencyPairHistory }`: adding a pair by hand
(`…currency_pairs.create`) and the drawer's "Fetch 6 months"
(`…currency_pairs.backfill`). Both fetch the same window — `today − 182 days` →
today, one ranged Bank of Canada call, recorded as an inline `on_demand` run —
and `history` says what it did:

```json
{ "status": "written", "from": "2026-03-14", "to": "2026-09-12",
  "days": 125, "latestDate": "2026-09-11",
  "created": 125, "updated": 0, "unchanged": 0,
  "current": true, "runId": "…", "error": null }
```

`status` is `written`, `unpublished` (the Bank publishes no series for one of
the currencies; the message is on the pair's `lastError` too), `busy` (another
run of `bank_of_canada_rates` held the integration), `unavailable` (the
integration is off or not installed) or `failed` (the call was made and the run
did not finish). Only the first is a success, and **none of them is an HTTP
error**: the pair is created, or is still watched, either way, and `error`
carries the sentence to show. `days` counts published observation days, so a
six-month window is about 125, never 182. `current` says the newest day the
Bank can have published was among them, which is when the pair's
`last_rated_at` is stamped and that night's run skips it. The one refusal is a
**409 on an inactive pair** for the backfill: switching a pair off is an
operator's decision that no fetch overturns.

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

## Cost center semantics

The first two cost endpoints read `admin_cost_daily` and `admin_cost_snapshots`
and **neither calls AWS**. Cost Explorer charges $0.01 per request and its data
lags about a day, so the `aws_costs` integration asks once a day (09:00
Toronto) and these two serve the cache. Refreshing is therefore not a cost
endpoint at all: it is `POST /api/v1/admin/integrations/aws_costs/run`, gated
by `can_write_integrations`, and it costs about $0.05.

Until [`docs/sql/013_aws_costs.sql`](./sql/013_aws_costs.sql) has run both
answer 503 `admin_schema_missing`. Afterwards, and before the job has ever
succeeded, both answer 200 — `{ snapshot: null, byService: [], byComponent:
[], lastRun: null }` and `[]` — because "we have not asked yet" and "the
account spent nothing" are different facts and the page says which.

Three conventions apply to every amount in both payloads:

- **USD**, always; nothing converts currency.
- **Credits and refunds are excluded** (`UnblendedCost` with `Not RECORD_TYPE
  in (Credit, Refund)`), so these are usage figures and the invoice can be
  lower. The forecast is the one exception — `GetCostForecast` does not accept
  that filter.
- **Nothing is counted for today.** Every window ends yesterday, the last day
  AWS has totalled, so on the 1st of a month `monthToDateUsd` and every
  `mtdUsd` are genuinely 0. `prev30Usd` is a *rolling* 30 days ending
  yesterday, not last calendar month. `estimated` on a day means AWS has not
  finalised it and it will change.

`byComponent` is empty until the `Component` cost allocation tag is activated
in the Billing console, and activation is not retroactive. A component of `""`
is spend the tag does not cover. Full detail in [costs.md](./costs.md).

### Cost per client

`admin.costs.per_client` is the third, and it is an **allocated estimate** — the
word is on every surface that shows it. AWS bills per resource and every
resource except an S3 object is shared by all tenants, so no API can answer
"what did this tenant cost". Instead the nightly `allocate_costs` run splits the
month's cached bill into four pools (shared capacity, storage, data transfer,
Cognito) and divides each by a measured driver (requests and sync rows,
attachment bytes plus an estimated row footprint, active users), writing
`admin_tenant_cost_monthly`. The endpoint only reads that table, sums the pool
totals from `admin_cost_daily`, and looks up tenant names and owners in the main
app database; it never recomputes and never calls AWS.

**`ownerEmail` is gated separately from the rest of the row.** The cost actions
buy the figures; the address of the person behind a tenant is personal data
belonging to the Customers feature, so the endpoint fills it in only for a
caller who holds `can_read_user_list` or `can_read_user_detail` as well. For
everybody else the field is `null` and the membership read that would have
produced it is never made — omitted, not blanked after the fact. `tenantName`
is not gated: it is what the rows are labelled with, and without it the table
is a list of UUIDs.

Each pool is divided in micro-dollars with a largest-remainder pass, so the
tenants' components sum to the pool exactly, and `pools.unallocatedUsd` is
whatever no tenant was given — a pool whose driver was zero everywhere, or a
bill revised since the last recomputation. Shares therefore need not sum to
100 %. Until [`docs/sql/015_cost_allocation.sql`](./sql/015_cost_allocation.sql)
has run it answers 503 `admin_schema_missing`; afterwards, and before the job
has ever run, it answers 200 with the pools, `tenants: []` and
`computedAt: null`. The model, its two invented constants and its caveats are
in [cost-allocation.md](./cost-allocation.md).

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
