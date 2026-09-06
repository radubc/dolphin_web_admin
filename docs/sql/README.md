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

1. Write the change as a new numbered file here (`004_….sql`), transactional,
   with comments saying what and why.
2. Run it in pgAdmin.
3. `npx prisma db pull --config prisma-admin.config.ts`, then
   `npm run prisma:generate`.
4. Update the code that uses the table, and the matching page in `docs/`.

Never run `prisma migrate` or `db push` against either database from this
repository: the SQL files are the migration history.
