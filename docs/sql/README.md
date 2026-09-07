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

Until step 7 has run, the Constants list, compare, push and job endpoints
answer 503 `admin_schema_missing`: the app does not fake a ledger it does not
have. The same applies to step 8 and the Integrations endpoints, with two
exceptions: the two service (API-key) lookups answer 200 with every item
`unavailable`, and the scheduler logs one warning and then stays idle — a
machine client and a background timer must not be handed a 503 they cannot
act on.

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

1. Write the change as a new numbered file here (`010_….sql`), transactional,
   with comments saying what and why.
2. Run it in pgAdmin.
3. `npx prisma db pull --config prisma-admin.config.ts`, then
   `npm run prisma:generate`.
4. Update the code that uses the table, and the matching page in `docs/`.

Never run `prisma migrate` or `db push` against either database from this
repository: the SQL files are the migration history.
