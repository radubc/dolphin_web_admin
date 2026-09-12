@AGENTS.md

# Penny Squeeze — admin app (dolphin_web_admin)

Internal admin console for the Penny Squeeze personal-finance product: operator sign-in through an admin-only Cognito pool, default-deny role-based access, and read/write tooling over the consumer app's data. Next.js 16 (App Router) + React 19 + TypeScript on Node 24, Tailwind v4 + Ant Design 6 for UI, Prisma 7 (pg adapter) against two PostgreSQL databases, AWS Cognito for auth. Early stage: sign-in, session refresh and the authenticated shell (nav bar, side rail, quick actions) are ported from the consumer app; User Management, Access Map, Services, Constants and Integrations run on the admin database through Prisma (`ADMIN_ACCESS_STORE=mock` selects the in-memory mock); Overview and Support are still blank. Human-readable guides live in `docs/*.md`. The consumer web app lives beside this repo at `../penny-squeeze-web` and is the reference implementation for the API toolkit, auth, and session code.

## Commands
- `npm run dev` — dev server (Turbopack) on http://localhost:3001 (3000 belongs to the consumer app)
- `npm run build` / `npm run start` — production build and serve (start also binds 3001)
- `npm run lint` — ESLint (flat config)
- `npx tsc --noEmit` — type check
- `npm run prisma:generate` — regenerate **both** clients into `src/generated/prisma/` and `src/generated/prisma-admin/`
- `npx prisma <cmd> --config prisma-admin.config.ts` — run any Prisma CLI command against the admin database; without `--config` it targets the main database
- `npx prisma migrate dev --config prisma-admin.config.ts` — create/apply an admin-database migration (ask first; touches the DB). Never migrate the main database from here

## Layout
- `src/app/` — routes, root layout, global CSS
- `src/app/(app)/` — the authenticated pages (`/` Overview, `/constants`, `/integrations`, `/customers`, `/user-management`, `/support`, `/access-map`, `/services`). `page-registry.ts` gives each a `section`: `main` pages are rail tabs, `settings` pages (User Management) live in the nav bar's gear menu; the access map still decides who may open each
- `src/app/login/`, `src/app/forgot-password/` — the auth pages; `src/app/api/auth/` — refresh and logout routes
- `src/app/api/` — Route Handlers; business endpoints under `/api/v1/`
- `src/lib/api/` — API toolkit: handler wrapper, auth, validation, response/error helpers
- `src/lib/security/` — rate limiting and client IP resolution
- `src/lib/auth/` — Cognito sign-in, cookie session (`psa_` prefix), refresh
- `src/lib/admin-access/` — access control: `types.ts` (model + `evaluateRule`), `repository.ts` (storage seam: `prisma-repository.ts` by default, `mock.ts` with `ADMIN_ACCESS_STORE=mock`), `authorize.ts` (`requireAdminSession`, `requirePageAccess`, `adminHandler`), `page-registry.ts` + `endpoint-registry.ts` (what the build ships; rules live in the DB), `client.ts` + stores (browser side)
- `src/app/api/v1/admin/` — users, roles, actions, audit, pages, endpoints, usage, me, constants, integrations, customers; every handler goes through `adminHandler(fn, { endpoint })`
- `src/app/api/v1/service/` — machine endpoints for the consumer app (`quotes`, `exchange-rates`, `defaults/categories`, `defaults/financial-institutions`), exported through `serviceHandler` and authenticated with `API_KEYS`; each must be listed in `PUBLIC_API_PATHS` in `src/proxy.ts`
- `src/lib/integrations/` — external providers: `types.ts` (wire model), `providers/` (TwelveData and Bank of Canada fetch + parse, no Prisma), `jobs/` (what each run does: catalogs, quotes, rates), `runs.ts` (in-process run records, mirrors `constants/jobs.ts`), `lookup.ts` (the on-demand paths behind the service endpoints), `schedule.ts` (next-run math) + `scheduler.ts` (the per-minute ticker started from `src/instrumentation.ts`), `service.ts` / `repository.ts` / `schemas.ts`, `client.ts` (browser side)
- `src/components/user-management/`, `access-map/`, `services/`, `constants/`, `integrations/`, `customers/` — the built pages
- `src/lib/constants/` — the ten reference catalogs the Constants page edits (`types.ts` wire model, `repository.ts`, `service.ts`, the sync `ledger.ts` and the `compare`/`push` jobs). Eight kinds are **pushed** into the main database; `categories` and `financial_institutions` are **pulled** by the consumer app at tenant creation (`PULLED_KINDS`, `defaults.ts`, the two `service/defaults/*` endpoints) and their push/compare answer 409
- `src/lib/customers/` — the consumer app's users read from the main database (read-only), their status in the **customer** Cognito pool, and invitations (`AdminCreateUser` on that pool, recorded in `admin_customer_invites`); `config.ts` reads the `CUSTOMER_COGNITO_*` variables and never falls back to the admin pool
- `docs/sql/` — numbered SQL the owner runs in pgAdmin against the admin DB; `docs/*.md` — guides for people
- `src/components/shell/` — nav bar, side rail, quick actions; tabs and actions are listed in `definitions.ts`, routes in `routes.ts`
- `public/brand/` — logo assets copied from the consumer app
- `src/lib/prisma.ts` — the only place the **main-database** PrismaClient is constructed (`prisma`)
- `src/lib/prisma-admin.ts` — the only place the **admin-database** PrismaClient is constructed (`prismaAdmin`)
- `prisma/schema.prisma` + `prisma.config.ts` — main database (owned by the consumer app; read-mostly, never migrated from here)
- `prisma-admin/schema.prisma` + `prisma-admin.config.ts` — admin database (catalogs plus the `admin_*` RBAC tables)
- `src/generated/prisma/`, `src/generated/prisma-admin/` — generated, git-ignored, never hand-edit
- `docs/admin-access/README.md` — the original RBAC design note
- `.cursor/rules/` — Cursor-side rules; the filesystem-scope rule there applies here too: stay inside `~/Developer/projects`

## Environment variables
Names only; values live in `.env`, which is never read or quoted by an agent.
- `DATABASE_URL` — main app PostgreSQL connection string (consumer data)
- `ADMIN_DATABASE_URL` — admin PostgreSQL connection string (`admin_penny_squeeze`)
- `ADMIN_COGNITO_REGION`, `ADMIN_COGNITO_USER_POOL_ID`, `ADMIN_COGNITO_CLIENT_ID` — the **admin-only** Cognito pool. `src/lib/auth/config.ts` reads these first, then `COGNITO_*` / `AWS_REGION`, then `NEXT_PUBLIC_COGNITO_*`; the `.env` currently uses the `NEXT_PUBLIC_` spellings and points at the admin pool
- `ADMIN_COGNITO_CLIENT_SECRET` (fallback `COGNITO_CLIENT_SECRET`) — optional, only when the app client has a secret. Server-only, no public fallback
- `CUSTOMER_COGNITO_USER_POOL_ID`, `CUSTOMER_COGNITO_REGION` — the **consumer app's** Cognito pool, for the Customers page and invitations only. Never the admin pool; the pool id has no fallback on purpose. The Admin* calls are signed with AWS credentials from the SDK's default chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.env`, a profile, or an instance role) that allow `cognito-idp:ListUsers`, `AdminCreateUser`, `AdminGetUser` and `AdminDeleteUser` on that pool
- `ADMIN_SUB` — Cognito `sub` of the owner. The mock repository seeds its super-admin row with it; the Prisma version will use it only for the bootstrap insert, never for a runtime decision
- `API_KEYS` — optional, comma-separated keys (min 32 chars each) for machine clients; two entries allow a rotation
- `TWELVEDATA_API_KEY` — TwelveData key for the quote integration and the on-demand quote endpoint. Server-only; the Integrations page shows only whether it is set. The catalog download and the Bank of Canada rates need no key
- `ALPHA_VANTAGE_API_KEY` — Alpha Vantage key for the `alpha_vantage_quotes` fallback (quotes for TSX and other listings TwelveData's free plan refuses). Server-only; Alpha Vantage accepts it only as a query parameter, so those URLs are redacted before any log or error. Without it the fallback is skipped
- `INTEGRATIONS_SCHEDULER` — optional; `off` stops this process from running scheduled integrations (a second local dev server, a script). The Integrations page shows a banner when it is off
- `TRUST_PROXY_HEADERS` — set to `true` only when a single trusted load balancer sits in front of the app. **Production must set it:** while it is unset the client IP is unknown and every per-IP rate limit is switched off
- `DATABASE_POOL_MAX` — optional; the `pg` pool size (`max`) for both `prisma` and `prismaAdmin` (`src/lib/prisma.ts`, `src/lib/prisma-admin.ts`). Integer, default `10` (pg's own default; the ECS task definition sets `5`) when unset or not a positive integer. The same value applies to both clients, so a container opens up to `DATABASE_POOL_MAX * 2` connections total
- `BUILD_ID` — build-time only, not read at runtime. The deploy workflow sets it to the commit SHA and passes it as a Docker build ARG; `next.config.ts` reads it into `deploymentId` so a rolling deployment can detect version skew between old and new instances

## Branches
Mirrors the consumer app: `develop` (working branch) → `stage` → `production`. `main` is the GitHub default and PR target. Never push to `stage` or `production` directly.

## Working rules
Detailed rules live in `.claude/rules/` (orchestration, Next.js, database, api, auth, ui) and load automatically. The non-negotiables:
1. Never remove or disable existing functionality without the owner's explicit approval.
2. Read `node_modules/next/dist/docs/` before writing Next.js code; this version has breaking changes.
3. Never read `.env`. Never hand-edit generated Prisma code. Never run destructive DB commands. Never migrate either database from this repo: schema changes are numbered SQL files in `docs/sql/` that the owner runs in pgAdmin, followed by `npx prisma db pull --config prisma-admin.config.ts` and `npm run prisma:generate`.
4. Authorization is default-deny and lives in the admin database: pages call `requirePageAccess("<key>")`, routes export through `adminHandler(fn, { endpoint: "<key>" })`, and the required actions come from the access map (`admin_pages`, `admin_endpoints`), never from code. A new page or endpoint gets a registry entry and is super-admin only until registered on the Access Map. Never derive access from the main database's `users` table or the end-user Cognito pool.
5. The main session orchestrates; subagents (max 4) in `.claude/agents/` do the work: `implementer` (Sonnet) for simple tasks, `architect` (Opus) for complex ones, `explorer` and `reviewer` for read-only research and review.
6. Commit only when asked. Branch off `develop`.
