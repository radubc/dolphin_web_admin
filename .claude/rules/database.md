---
paths:
  - "prisma/**"
  - "prisma-admin/**"
  - "prisma.config.ts"
  - "prisma-admin.config.ts"
  - "src/lib/prisma.ts"
  - "src/lib/prisma-admin.ts"
  - "src/lib/**/*.ts"
  - "src/app/**/actions.ts"
  - "src/app/api/**"
  - "docs/admin-access/**"
---

# Prisma 7 and the two PostgreSQL databases

This app talks to two databases through two separately generated clients. Pick the right one for the table you are touching; never mix them in one transaction.

| | Main app database | Admin database |
| --- | --- | --- |
| Env var | `DATABASE_URL` | `ADMIN_DATABASE_URL` |
| Schema | `prisma/schema.prisma` | `prisma-admin/schema.prisma` |
| CLI config | `prisma.config.ts` (default) | `prisma-admin.config.ts` (pass `--config prisma-admin.config.ts`) |
| Generated client | `src/generated/prisma/` | `src/generated/prisma-admin/` |
| Singleton | `prisma` from `src/lib/prisma.ts` | `prismaAdmin` from `src/lib/prisma-admin.ts` |
| Owner | the consumer app (penny-squeeze-web, macOS app). Introspected; read-mostly here | this app. Catalog tables plus the RBAC tables in `docs/admin-access/admin_access.sql` |

- Prisma 7 with the `prisma-client` generator (not `prisma-client-js`). Both outputs are git-ignored; regenerate both with `npm run prisma:generate` (runs `prisma generate` for each config). Import from `@/generated/prisma/client` or `@/generated/prisma-admin/client`.
- Runtime uses the pg driver adapter (`@prisma/adapter-pg`). Always use the two singletons; never `new PrismaClient()` elsewhere.
- Connection config lives in the two `*.config.ts` files (they read the env var via dotenv). The datasource blocks in both schemas intentionally have no `url`.
- **Main database:** its schema is introspected from the live database with `prisma db pull` (ask first; it rewrites the file) and many models carry row-level security. Never create or run a migration against it from this repo, and treat writes as an explicit product decision that the consumer app has to tolerate. Reads are the norm.
- **Admin database:** schema changes are numbered, transactional SQL files in `docs/sql/` (`NNN_name.sql`) that the owner runs in pgAdmin. After that: `npx prisma db pull --config prisma-admin.config.ts` (ask first; it rewrites the schema file), `npm run prisma:generate`, `npx tsc --noEmit`. Never `prisma migrate` or `db push`. The `admin_*` models in `prisma-admin/schema.prisma` were hand-written to match `docs/sql/001` and `002`; keep them and the SQL in step.
- Never remove a model, field, or enum value without approval; that is a data-loss change.
- Prefer typed Prisma queries over `$queryRaw`. If raw SQL is unavoidable, use tagged templates so values are parameterised.
- Database access only from server code (Server Components, Server Actions, Route Handlers). Never import either Prisma client into a `"use client"` file.
- Money values: use `Decimal` columns, not `Float`.
- Authorization lives in the admin database only (`admin_users`, `admin_roles`, `admin_actions`, and the join tables). Never grant admin access based on the main database's `users` table.
