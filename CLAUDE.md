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
- `src/app/(app)/` — the authenticated pages (`/` Overview, `/constants`, `/integrations`, `/user-management`, `/support`, `/access-map`, `/services`)
- `src/app/login/`, `src/app/forgot-password/` — the auth pages; `src/app/api/auth/` — refresh and logout routes
- `src/app/api/` — Route Handlers; business endpoints under `/api/v1/`
- `src/lib/api/` — API toolkit: handler wrapper, auth, validation, response/error helpers
- `src/lib/security/` — rate limiting and client IP resolution
- `src/lib/auth/` — Cognito sign-in, cookie session (`psa_` prefix), refresh
- `src/lib/admin-access/` — access control: `types.ts` (model + `evaluateRule`), `repository.ts` (storage seam: `prisma-repository.ts` by default, `mock.ts` with `ADMIN_ACCESS_STORE=mock`), `authorize.ts` (`requireAdminSession`, `requirePageAccess`, `adminHandler`), `page-registry.ts` + `endpoint-registry.ts` (what the build ships; rules live in the DB), `client.ts` + stores (browser side)
- `src/app/api/v1/admin/` — users, roles, actions, audit, pages, endpoints, usage, me, constants, integrations; every handler goes through `adminHandler(fn, { endpoint })`
- `src/app/api/v1/service/` — machine endpoints for the consumer app (`quotes`, `exchange-rates`), exported through `serviceHandler` and authenticated with `API_KEYS`; each must be listed in `PUBLIC_API_PATHS` in `src/proxy.ts`
- `src/lib/integrations/` — external providers: `types.ts` (wire model), `providers/` (TwelveData and Bank of Canada fetch + parse, no Prisma), `jobs/` (what each run does: catalogs, quotes, rates), `runs.ts` (in-process run records, mirrors `constants/jobs.ts`), `lookup.ts` (the on-demand paths behind the service endpoints), `schedule.ts` (next-run math) + `scheduler.ts` (the per-minute ticker started from `src/instrumentation.ts`), `service.ts` / `repository.ts` / `schemas.ts`, `client.ts` (browser side)
- `src/components/user-management/`, `access-map/`, `services/`, `constants/`, `integrations/` — the built pages
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
- `ADMIN_SUB` — Cognito `sub` of the owner. The mock repository seeds its super-admin row with it; the Prisma version will use it only for the bootstrap insert, never for a runtime decision
- `API_KEYS` — optional, comma-separated keys (min 32 chars each) for machine clients; two entries allow a rotation
- `TWELVEDATA_API_KEY` — TwelveData key for the quote integration and the on-demand quote endpoint. Server-only; the Integrations page shows only whether it is set. The catalog download and the Bank of Canada rates need no key
- `ALPHA_VANTAGE_API_KEY` — Alpha Vantage key for the `alpha_vantage_quotes` fallback (quotes for TSX and other listings TwelveData's free plan refuses). Server-only; Alpha Vantage accepts it only as a query parameter, so those URLs are redacted before any log or error. Without it the fallback is skipped
- `INTEGRATIONS_SCHEDULER` — optional; `off` stops this process from running scheduled integrations (a second local dev server, a script). The Integrations page shows a banner when it is off
- `TRUST_PROXY_HEADERS` — set to `true` only when a single trusted load balancer sits in front of the app. **Production must set it:** while it is unset the client IP is unknown and every per-IP rate limit is switched off

## Branches
Only `main` exists so far (GitHub default and PR target). Mirror the consumer app once more branches are needed: `develop` (working branch) → `stage` → `production`, never pushing to `stage` or `production` directly. Until then, branch off `main`.

## Working rules
Detailed rules live in `.claude/rules/` (orchestration, Next.js, database, api, auth) and load automatically. The non-negotiables:
1. Never remove or disable existing functionality without the owner's explicit approval.
2. Read `node_modules/next/dist/docs/` before writing Next.js code; this version has breaking changes.
3. Never read `.env`. Never hand-edit generated Prisma code. Never run destructive DB commands. Never migrate either database from this repo: schema changes are numbered SQL files in `docs/sql/` that the owner runs in pgAdmin, followed by `npx prisma db pull --config prisma-admin.config.ts` and `npm run prisma:generate`.
4. Authorization is default-deny and lives in the admin database: pages call `requirePageAccess("<key>")`, routes export through `adminHandler(fn, { endpoint: "<key>" })`, and the required actions come from the access map (`admin_pages`, `admin_endpoints`), never from code. A new page or endpoint gets a registry entry and is super-admin only until registered on the Access Map. Never derive access from the main database's `users` table or the end-user Cognito pool.
5. The main session orchestrates; subagents (max 4) in `.claude/agents/` do the work: `implementer` (Sonnet) for simple tasks, `architect` (Opus) for complex ones, `explorer` and `reviewer` for read-only research and review.
6. Commit only when asked. Branch off `main` until `develop` exists.
