# Databases

The console reads two PostgreSQL databases through two separately generated
Prisma clients. Never mix them in one transaction.

| | Main app database | Admin database |
| --- | --- | --- |
| Env var | `DATABASE_URL` | `ADMIN_DATABASE_URL` |
| Schema file | `prisma/schema.prisma` | `prisma-admin/schema.prisma` |
| CLI config | `prisma.config.ts` (default) | `prisma-admin.config.ts` (pass `--config prisma-admin.config.ts`) |
| Generated client | `src/generated/prisma/` | `src/generated/prisma-admin/` |
| Import | `prisma` from `src/lib/prisma.ts` | `prismaAdmin` from `src/lib/prisma-admin.ts` |
| Owner | the consumer app (web + mac). Introspected here; read-mostly. | this app: catalog tables and the `admin_*` tables. |

Both generated clients are git-ignored; `npm run prisma:generate` rebuilds
them. Prisma 7 with the pg driver adapter; connection strings come from `.env`
through the two config files, so the schema files carry no URL.

## The admin tables

| Table | Purpose | Managed on |
| --- | --- | --- |
| `admin_users` | operators allowed in (Cognito sub, email, super-admin flag, disabled_at) | User Management → Users |
| `admin_actions` | permission catalog | SQL |
| `admin_roles`, `admin_role_actions` | roles and their grants | User Management → Roles |
| `admin_user_roles` | who holds which role | User Management → Users |
| `admin_permission_audit_events` | append-only trail of every change above and of rule changes | User Management → Audit log |
| `admin_pages`, `admin_page_actions` | access map for pages and quick actions | Access Map |
| `admin_endpoints`, `admin_endpoint_actions` | access map and metadata for endpoints | Access Map |
| `admin_endpoint_usage` | per-endpoint, per-day counters | Services (read-only) |
| `admin_constant_sync` | Constants sync ledger: one row per (kind, catalog row) with `new` / `changed` / `synced`, plus `main_only` ids | Constants (compare, push and every edit) |
| `admin_constant_jobs` | Constants compare and push jobs: request, progress, counters, outcome | Constants (read-only; rows are written by the job runner) |

The full DDL with comments is in `docs/sql/`. The Prisma models in
`prisma-admin/schema.prisma` were written by hand to match it.

## Changing the admin schema

The app never migrates a database. The workflow is:

1. **Write SQL** as a new numbered, transactional file in `docs/sql/`
   (`008_….sql`), with comments. Include seeds if the change needs data.
2. **Run it in pgAdmin** against `admin_penny_squeeze`. See
   [sql/README.md](./sql/README.md).
3. **Pull the schema into Prisma** so the models match the live database:

   ```bash
   npx prisma db pull --config prisma-admin.config.ts
   ```

   Review the diff of `prisma-admin/schema.prisma`; cosmetic changes to
   relation names are normal. If it removes something the code uses, the type
   check will say so.
4. **Regenerate the clients** and type-check:

   ```bash
   npm run prisma:generate
   ```

   ```bash
   npx tsc --noEmit
   ```

5. Update the repository (`src/lib/admin-access/prisma-repository.ts` and the
   mock), the registries if a page or endpoint changed, and the matching guide
   here. Commit the SQL file and the pulled schema together.

`prisma migrate`, `db push` and `migrate reset` are deliberately not used
against either database: the SQL files are the migration history and pgAdmin
is where they run.

## The main database

Its schema is introspected from the consumer app's database
(`npx prisma db pull`, default config) and many models carry row-level
security. Treat it as read-only from this app until a feature explicitly needs
a write, and never run a migration against it from here.

**The one deliberate write path** is the Constants push: `pushWork` in
`src/lib/constants/push.ts` upserts ten reference tables **by id**, in batches
of 1000 with one transaction each —
`countries`, `currencies`, `financial_institutions`, `categories`,
`account_base_types`, `account_types`, plus the market-data catalogs
`preload_cryptocurrencies`, `preload_etfs`, `preload_stocks` and `markets` —
from the admin catalogs the console edits. It never deletes a row there,
because tenant data (accounts, transactions, budgets, loans, portfolios)
references these ids; a category, account type or market that is retired in the
admin database travels across as a `deleted_at` timestamp, not as a delete.
The three `preload_*` tables key on an integer sequence and the push keeps the
admin id, so each group that inserted also advances that table's sequence past
what it wrote. None of the ten tables has row-level security.

The main database is also **read** in bulk by the Constants compare job, which
walks each of those ten tables by primary key to rebuild the sync ledger. See
[constants.md](./constants.md).

## Mock or real

`getAdminAccessRepository()` uses Prisma unless `ADMIN_ACCESS_STORE=mock` is
set. When the admin tables do not exist yet, every page redirects to `/setup`
with instructions and the API answers 503 `admin_schema_missing`.
