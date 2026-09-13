# Database scripts

SQL to run **by hand in pgAdmin** against the **admin** database
(`admin_penny_squeeze`, the `ADMIN_DATABASE_URL` connection). Nothing here
touches the main app database. The app never runs these itself; the files are
the source of truth for the `admin_*` schema, and Prisma is pointed at the
result afterwards.

## Order

| Step | File | What it does | Run when |
| --- | --- | --- | --- |
| 1 | [`001_admin_access.sql`](./001_admin_access.sql) | Allowlist, actions, roles, grants, audit trail, plus the seeded catalog and three system roles. | Once, on a fresh admin database. |
| 2 | [`002_access_map_and_services.sql`](./002_access_map_and_services.sql) | Access map (`admin_pages`, `admin_page_actions`), service registry (`admin_endpoints`, `admin_endpoint_actions`), usage counters, two new actions, seeds for every page and endpoint. | Once, after step 1. |
| 3 | [`003_bootstrap_owner.sql`](./003_bootstrap_owner.sql) | Inserts you as the first super-admin. Check the sub and email first. | Once, after step 2. Re-running is safe. |
| 4 | [`004_constants.sql`](./004_constants.sql) | Registers the six Constants endpoints and their action links, and lets the audit trail record `target_type = 'catalog'` (written once per push). Creates no tables. | Once, after step 3. Re-running is safe. |
| 5 | [`005_constants_unique_indexes.sql`](./005_constants_unique_indexes.sql) | Case-insensitive unique indexes on currency codes, country codes, institution names and live category names per parent, so a duplicate is refused by the database and not only by the app. | Once, after step 4. Re-running is safe; fails (and applies nothing) if duplicates exist. |
| 6 | [`006_account_types_unique_index.sql`](./006_account_types_unique_index.sql) | Case-insensitive unique index on live account type names per base type, for the two catalogs added to Constants (`account_base_types`, `account_types`). Creates no tables; base type names are already unique. | Once, after step 5. Re-running is safe; fails (and applies nothing) if duplicates exist. |
| 7 | [`007_constants_sync_and_jobs.sql`](./007_constants_sync_and_jobs.sql) | The Constants sync ledger (`admin_constant_sync`) and job records (`admin_constant_jobs`), plus the three new endpoints (compare, jobs list, jobs get) and their action links. This is what lets a 300 000-row catalog be listed, compared and pushed. | Once, after step 6. Re-running is safe. |
| 8 | [`008_integrations.sql`](./008_integrations.sql) | The Integrations feature: `admin_integrations` (three seeded providers), `admin_integration_runs`, the quote watch list and cache (`admin_quote_symbols`, `admin_quotes`) and the currency pair watch list and cache (`admin_currency_pairs`, `admin_exchange_rates`), plus two actions, the `integrations` page and the fifteen new endpoints. Also widens `admin_endpoints.auth_kind` to allow `'service'` (API-key machine clients). | Once, after step 7. Re-running is safe. |
| 9 | [`009_markets_and_alpha_vantage.sql`](./009_markets_and_alpha_vantage.sql) | Two more integrations: `iso_mic_markets` (the ISO 10383 MIC register, which fills the empty `markets` catalog) and `alpha_vantage_quotes` (the quote fallback for TSX and other listings TwelveData's free plan refuses). Widens `admin_integrations.provider` to allow `'iso20022'` and `'alpha_vantage'`, and adds the nullable `admin_quote_symbols.provider` that routes each symbol to the provider which last served it. Creates no tables and registers no new endpoints — the integration routes are keyed by `[key]`. | Once, after step 8. Re-running is safe. |
| 10 | [`010_customers.sql`](./010_customers.sql) | The Customers feature: `admin_customer_invites` (the record of every invitation to the consumer app, with a partial unique index allowing only one open invitation per address), the `can_invite_users` action, the `customers` page and the `invite_customer` quick action, and the six Customers endpoints. Also widens the audit trail's `target_type` check so an invitation can be audited (`'customer_invite'`). | Once, after step 9. Re-running is safe. |
| 11 | [`011_service_defaults_endpoints.sql`](./011_service_defaults_endpoints.sql) | Registers the two machine endpoints the consumer app pulls its defaults from (`service.defaults.categories`, `service.defaults.financial_institutions`). Creates no tables and grants no actions — an API-key endpoint consults no rule; this only puts the two on the Services page with usage counters, and both work before it has run. Both catalogs (categories and financial institutions) must already be seeded in the admin database before this: an empty one answers 503 `defaults_unavailable` and the consumer app refuses to create a tenant. | Once, after step 10. Re-running is safe. |
| 12 | [`012_cost_center_sales_marketing_pages.sql`](./012_cost_center_sales_marketing_pages.sql) | Registers three new rail pages, keyed `cost_center`, `sales_billing` and `marketing` (underscores: `admin_pages.key` refuses a hyphen, so the keys differ from the `/cost-center`, `/sales-billing` and `/marketing` paths). Creates no tables, no endpoints and **no actions**; all three ship `require_super_admin = TRUE` with no linked actions until the owner grants a role on the Access Map. | Once, after step 11. Re-running is safe. |
| 13 | [`013_aws_costs.sql`](./013_aws_costs.sql) | The Cost center's data: `admin_cost_daily` (AWS cost per day and service in `NUMERIC(14,6)`, and the split by the `Component` cost allocation tag) and `admin_cost_snapshots` (one row per job run: month to date, forecast, budget, free tier, anomalies). Seeds the `aws_costs` integration (daily, 09:00 Toronto, about $1 a month in Cost Explorer requests), widens `admin_integrations.provider` to allow `'aws'`, seeds the `can_read_costs` / `can_write_costs` actions (step 12 creates none) and links them to 012's `cost_center` page, and registers the two Cost center endpoints against those same two actions, named explicitly so neither endpoint can end up with no actions at all. **Needs PostgreSQL 15+** for `UNIQUE NULLS NOT DISTINCT`. | Once, after step 12. Re-running is safe. |
| 14 | [`014_customer_statistics.sql`](./014_customer_statistics.sql) | The Customers page's Activity view: `admin_customer_snapshots` (one row per Cognito pool account per day the nightly job saw it, `partial` marking a day whose pool listing was cut short), `admin_customer_events` (the lifecycle log — invited, confirmed, disabled, enabled, deleted, reappeared, deleted_in_app) and `admin_pool_metrics_daily` (the pool's daily CloudWatch sign-in and sign-up counters). Seeds the `cognito_directory` integration (daily, 02:30 Toronto) and registers the two statistics endpoints with the same three actions 010 gave the Customers reads (`can_read_user_list`, `can_read_user_detail`, `can_invite_users`), named explicitly so neither endpoint can end up with no actions at all. Creates no actions of its own. Must run **after** 013, which is what first allowed `admin_integrations.provider = 'aws'`. | Once, after step 13. Re-running is safe. |
| 15 | [`015_cost_allocation.sql`](./015_cost_allocation.sql) | Cost per client: `admin_tenant_cost_monthly` (one row per tenant and month — the four pool components of the allocated estimate, the total, the tenant's share of the bill, and the drivers the split was made from). Seeds the `allocate_costs` integration (daily, 03:30 Toronto — it calls nothing, so it is free) and registers the `admin.costs.per_client` endpoint with the two cost actions 013 seeded (`can_read_costs`, `can_write_costs`), named explicitly so the endpoint cannot end up with no actions at all. Creates no actions of its own. Must run **after** 013, whose cost rows it divides up. | Once, after step 14. Re-running is safe. |
| 16 | [`016_stage_table_ownership.sql`](./016_stage_table_ownership.sql) | **Stage only.** Hands the six tables 013–015 created to the `fairsums_console` role, which is the role the console connects as on stage; they were created as the RDS master user, so the console got `permission denied for table admin_cost_daily`. Creates nothing and changes no data: it is `ALTER TABLE … OWNER TO` for exactly those six, skipping with a NOTICE any that is missing or already owned. Not needed locally, where the scripts and the app both run as `postgres`. | Once, after step 15, **as the current owner** (`fairsums_admin`). Re-running is safe. |
| 17 | [`017_currency_pair_history.sql`](./017_currency_pair_history.sql) | Registers the currency pair download-history endpoint (`admin.integrations.currency_pairs.rates`, behind the drawer a row click opens) against the two integration actions 008 seeded, and **deletes the stray rate rows**: every `admin_exchange_rates` row whose pair is not on `admin_currency_pairs`. Those are what the retired series cache wrote — about 27 `X → CAD` rows a day for pairs nobody watches. The app no longer writes them (the fetched document is now memoised in process instead), so this only clears what is already there. Creates no table and no action. **Read the header before running: it holds the SELECT that shows what the DELETE would remove.** | Once, after step 16, **before** any pair is removed from the watch list: the DELETE cannot tell a stray series row from the history of a pair an operator has since removed (the app keeps that history on Remove), so a later run would delete it too. Run the header's SELECT first. |
| 18 | [`018_account_security_endpoints.sql`](./018_account_security_endpoints.sql) | Registers the nine **Account & security** endpoints (`admin.me.password.change`, the three `admin.me.mfa.totp.*`, `admin.me.mfa.get` and the four `admin.me.passkeys.*`) behind the drawer the avatar menu opens. Creates no table and no action, and links **no** actions on purpose: each one acts on the caller's own Cognito account only — the access token names the subject and no request carries a user id — so a registered endpoint with an empty action list ("any enabled operator") is the correct rule, exactly as `admin.me` is registered in 002. The MFA and passkey routes work only once the admin user pool is reconfigured (see [../auth.md](../auth.md)); until then they answer 503 quoting Cognito. | Once, after step 17. Re-running is safe. |
| 19 | [`019_currency_pair_backfill.sql`](./019_currency_pair_backfill.sql) | Registers the currency pair **history backfill** endpoint (`admin.integrations.currency_pairs.backfill`, the "Fetch 6 months" button beside Refresh in the pair's download-history drawer) against `can_write_integrations`, the action 008 seeded for every integrations write. Creates no table and no action, and touches no watch row or rate. The other half of the same change — a manual add fetching six months on the spot — needed no SQL at all: it is the existing create endpoint doing more, and only its response body grew. | Once, after step 18. Re-running is safe. |

Until step 7 has run, the Constants list, compare, push and job endpoints
answer 503 `admin_schema_missing`: the app does not fake a ledger it does not
have. The same applies to step 8 and the Integrations endpoints, with two
exceptions: the two service (API-key) lookups answer 200 with every item
`unavailable`, and the scheduler logs one warning and then stays idle — a
machine client and a background timer must not be handed a 503 they cannot
act on.

Until step 10 has run, the two Customers **list** endpoints — the customer
list and the invitations list — answer 503 `admin_schema_missing`: the
customer list itself only needs the main app database, but every page load
also reconciles the invitations, and a list of invitations that silently
pretends to be empty would be worse than a clear "run the SQL". `GET
/api/v1/admin/customers/[id]` does not touch `admin_customer_invites` and
answers 200 regardless. Sending an invitation additionally needs
`CUSTOMER_COGNITO_USER_POOL_ID` and AWS credentials — see
[customers.md](../customers.md).

Until step 13 has run, the two Cost center endpoints answer 503
`admin_schema_missing` and the `aws_costs` integration does not exist (a run
request for it is a 404). Afterwards the endpoints answer 200 with an empty
snapshot until the job has succeeded once. The job also needs **two AWS
account settings that are not SQL**: Cost Explorer has to have been opened
once in the Billing console, and the `Application` / `Environment` /
`Component` cost allocation tags have to be activated there. Both take up to
24 hours and neither is retroactive — see [costs.md](../costs.md).

Until step 14 has run, the **statistics** endpoint answers 503
`admin_schema_missing` and the `cognito_directory` integration does not exist
(a run request for it is a 404). The rest of the Customers page is unaffected:
the customer list, the invitations and the per-customer drawer all work, and
the drawer simply shows no lifecycle events — its endpoint
(`admin.customers.activity`) reads everything but the events from the main app
database, so `eventsForSub` treats the missing `admin_customer_events` table as
an empty log (one warning line per process, naming this file) instead of
failing the drawer. The statistics endpoint does **not** get that treatment:
every pool-derived figure on it lives in these tables, and answering with
zeros would be inventing measurements. Afterwards both endpoints answer
200 immediately — the active-user, churn, retention, usage and largest-tenant
figures need no job at all — while the account census, the funnel's first two
steps and the sign-ins chart stay empty until the nightly job has succeeded
once. That job needs **two IAM permissions beyond what the Customers page
already uses**: `cognito-idp:DescribeUserPool` on the customer pool and
`cloudwatch:GetMetricData` on `*`. Without the CloudWatch one the snapshot and
the diff still work and only the pool metrics are skipped, with the reason in
the run record. See [customers.md](../customers.md).

Until step 15 has run, the cost-per-client endpoint answers 503
`admin_schema_missing` and the `allocate_costs` integration does not exist (a
run request for it is a 404). The rest of the Cost center is unaffected: the
"Cost per client" card says the figures have not been computed yet, and the
Customers page's "Cost (est.)" column shows a dash with the reason in its
tooltip. Afterwards the endpoint answers 200 immediately, with the month's pool
totals and an empty tenant list, until the nightly run has written the
allocation once. That run needs **no IAM permission and no account setting** —
both its inputs are already in the two databases — but it does need step 13's
`aws_costs` job to have cached the month, and it says so when it has not. The
model is [cost-allocation.md](../cost-allocation.md).

Until step 17 has run, the currency pair **history** drawer works only for a
super-admin: an endpoint with no `admin_endpoints` row is super-admin only, so
every other operator gets a 403 when they click a row. Nothing else on the
Integrations page is affected, and the stray rate rows the same file deletes
are harmless while they sit there — nothing reads them, and the app has already
stopped adding to them.

Until step 19 has run, the drawer's **Fetch 6 months** button works only for a
super-admin, for the same reason: every other operator gets a 403 when they
press it. Adding a pair by hand is unaffected — it fetches the same six months
through the create endpoint 008 already registered — so the only thing missing
before this file is run is the button for pairs that are on the list already.

The four market-data catalogs (`cryptocurrencies`, `etfs`, `stocks`,
`markets`) needed **no file of their own**: their tables already exist in the
admin database and were created with the unique constraints the app relies on
(`cryptocurrencies` on symbol + base + quote, `etfs` and `stocks` on
symbol + exchange, `markets` on `mic_code`), and they are served by the same
`[kind]` endpoints steps 4 and 7 registered. Step 9 fills the last of them:
`markets` is empty until the `iso_mic_markets` integration has run once.

Each file is one transaction: if a statement fails, nothing from that file is
applied. Fix the cause and run the file again.

## In pgAdmin

1. Connect to the server, expand **Databases → admin_penny_squeeze**.
2. **Tools → Query Tool**, open the file (folder icon) or paste it.
3. **Execute** (F5). The Messages tab should end with `COMMIT` and no errors.
4. Repeat for the next file.

## Then update Prisma

The Prisma schema for the admin database (`prisma-admin/schema.prisma`) already
contains hand-written models for every `admin_*` table, matching these files,
so the app compiles before the SQL has run. After running the SQL you can let
Prisma read the real database and confirm the two agree:

```bash
npx prisma db pull --config prisma-admin.config.ts
```

```bash
npm run prisma:generate
```

`db pull` rewrites `prisma-admin/schema.prisma` from the live database. Expect
cosmetic differences only (relation field names, ordering). If it drops or
changes a column the app uses, `npx tsc --noEmit` will say so. Commit the
pulled schema.

Then restart the dev server. The app reads the admin database by default; set
`ADMIN_ACCESS_STORE=mock` in `.env` to use the in-memory mock instead (useful
before the SQL has run).

## Adding a table or column later

1. Write the change as a new numbered file here (`020_….sql`), transactional,
   with comments saying what and why. (The next free number, always: 019 is
   taken.)
2. Run it in pgAdmin.
3. `npx prisma db pull --config prisma-admin.config.ts`, then
   `npm run prisma:generate`.
4. Update the code that uses the table, and the matching page in `docs/`.

Never run `prisma migrate` or `db push` against either database from this
repository: the SQL files are the migration history.
