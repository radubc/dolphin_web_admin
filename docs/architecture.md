# Architecture

The admin console is a Next.js 16 app (App Router, React 19, TypeScript) that
runs on Node. It talks to two PostgreSQL databases through Prisma and to AWS
Cognito for sign-in. There is no separate backend process: the API is a set of
Route Handlers inside the same app.

```
browser ──► proxy.ts ──► page (Server Component) ──► lib/* ──► Prisma ──► Postgres
                    └──► /api/* Route Handler ────► lib/* ──► Prisma ──► Postgres
                                                        └──► Cognito (sign-in, refresh)
```

## Folders

| Path | What lives there |
| --- | --- |
| `src/app/` | Routes. `(app)/` holds the authenticated pages behind one layout; `login/`, `forgot-password/`, `no-access/`, `setup/` are outside it. `api/` holds the Route Handlers. |
| `src/components/` | React components. `shell/` is the frame (nav bar, rail, quick actions); one folder per page (`user-management/`, `access-map/`, `services/`); the rest are shared chrome (page header, ribbon, list frame, figures, stat card, drawer sections). |
| `src/lib/auth/` | Cognito sign-in, cookie session, token verification, refresh. |
| `src/lib/api/` | The Route Handler toolkit: handler wrapper, authentication, validation, response envelope, errors, the browser client. |
| `src/lib/security/` | Rate limiting and client-IP resolution. |
| `src/lib/admin-access/` | Everything about *who may do what*: types, the storage seam, the mock and Prisma repositories, the authorization helpers, the page and endpoint registries, the browser stores. |
| `src/lib/prisma.ts`, `src/lib/prisma-admin.ts` | The two Prisma clients. |
| `prisma/`, `prisma-admin/` | The two schemas. |
| `docs/sql/` | SQL you run by hand to change the admin database. |
| `public/brand/` | Logo assets. |

## How a page request travels

1. **`src/proxy.ts`** runs first on every request. It only looks at cookie
   *presence*: no session cookie on a protected path means a redirect to
   `/login` (or, if a refresh cookie exists, through `/api/auth/refresh` and
   back). It never verifies anything.
2. **The `(app)` layout** calls `requireAdminSession()`: the id-token cookie is
   verified against the admin Cognito pool, then the caller's `sub` is looked up
   in `admin_users`. No enabled row → `/no-access`. It then loads the access
   map and hands the shell only the tabs and quick actions this person may
   open.
3. **The page** calls `requirePageAccess("<page key>")`, which repeats step 2
   (cached for the request) and evaluates the page's rule from the access map.
   Refused → `/no-access`.
4. The page renders. Client components fetch data from `/api/v1/…` with
   `apiFetch`, which knows the envelope and how to refresh an expired session.

## How an API request travels

1. The proxy answers a credential-less `/api/*` request with a JSON 401, unless
   the path is public (`/api/health`, the auth routes).
2. The route's exported handler is wrapped by `apiHandler`, which assigns a
   request id, applies the per-IP rate limit, translates thrown errors into
   the envelope, and afterwards records a usage hit for the Services page.
3. For operator endpoints, `adminHandler` sits on top: it authenticates
   (`protectedHandler`), resolves the allowlist row, loads the endpoint's rule
   from the access map, and refuses with 403 unless the rule allows.
4. The handler body parses input with zod, calls a repository method, and
   returns `ok(data)`.

## Where state lives

- **Session**: five httpOnly cookies, see [auth.md](./auth.md).
- **Access control**: the admin database, see [access-control.md](./access-control.md).
- **Rate-limit counters and usage recording**: in the Node process (rate
  limits) and in `admin_endpoint_usage` (usage).
- **UI state**: React state inside each page's store hook; nothing is kept in
  the browser between visits.

## The two repositories

`getAdminAccessRepository()` in `src/lib/admin-access/repository.ts` returns
either the Prisma implementation (default) or an in-memory mock
(`ADMIN_ACCESS_STORE=mock`). Both implement the same interface and the same
business rules, so pages and routes never know which one they talk to. The
mock is seeded with the SQL catalog, the system roles, the access map defaults
and a handful of invented operators; the owner row uses `ADMIN_SUB`.

## Conventions worth knowing

- Server Components by default; `"use client"` only where there is state or
  interaction.
- Never call a Route Handler from a Server Component: import the `lib`
  function directly.
- The consumer web app (`../penny-squeeze-web`) is the reference for the auth
  and API code; the two copies are kept in step rather than diverging.
