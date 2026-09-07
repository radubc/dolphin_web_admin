# Access control

Three layers decide what an operator can do. All three are data in the admin
database and editable in the console; the code only enforces them.

```
1. Allowlist   admin_users            Can this Cognito user get in at all?
2. Roles       admin_roles + actions  What action keys does this person hold?
3. Access map  admin_pages, admin_endpoints
                                      Which action keys does this page / endpoint need?
```

## 1. The allowlist

`admin_users` holds one row per operator, keyed by the Cognito `sub` of the
**admin** pool. After the token is verified, the row is looked up:

- no row, or `disabled_at` set → no access anywhere (`/no-access`, or 403 on
  the API);
- `is_super_admin = true` → allowed everything, and the only kind of user who
  may change users, roles, grants and the access map;
- otherwise the person's permissions are the union of their roles' actions.

`ADMIN_SUB` in `.env` is the owner's sub. `docs/sql/003_bootstrap_owner.sql`
inserts that row; the mock repository seeds it automatically.

## 2. Roles and actions

`admin_actions` is the catalog of atomic permissions (`can_read_tickets`,
`can_manage_roles`, …). `admin_roles` bundles them; `admin_role_actions` says
which actions a role grants; `admin_user_roles` says which roles a user holds.
The effective set for a user is the union over all their roles. Absence means
denied.

Roles and actions are managed on **User Management → Roles**. New action keys
are added by SQL (they are the contract with code) and then granted through
roles.

## 3. The access map

This is what answers "how does the app know which actions a page needs".

- `admin_pages` has one row per page **and** per quick action (`kind`). Each
  row says: `is_enabled`, `require_super_admin`, `nav_order`, and, through
  `admin_page_actions`, the actions of which the caller needs **any one**.
- `admin_endpoints` has one row per API endpoint (method + path), with the
  same rule columns through `admin_endpoint_actions`, plus metadata used by the
  Services page (`description`, `category`, `auth_kind`, `rate_limit_policy`,
  `notes`).

The code ships two *registries* that list what exists in the build, with
suggested defaults: `src/lib/admin-access/page-registry.ts` and
`endpoint-registry.ts`. They are catalogs, not rules. When the Access Map page
shows an entry that has no database row it says **Not registered** and offers
to write the row with those defaults.

### How a rule is evaluated

`evaluateRule()` in `src/lib/admin-access/types.ts`, used by both the server
and the browser:

1. Super-admin → **allow**, always.
2. No row → **unregistered** (refused). A page or endpoint that exists in code
   but has never been registered is super-admin only until someone registers
   it. This is deliberate: a new page cannot leak to operators by accident.
3. `is_enabled = false` → **disabled** (refused). A disabled page is hidden
   from everyone but super-admins, who still see it so they can turn it back
   on; a disabled endpoint answers 503 `endpoint_disabled`.
4. `require_super_admin = true` → **denied**.
5. No linked actions → **allow** (any enabled operator).
6. Otherwise **allow** if the caller holds at least one linked action, else
   **denied**.

### Where it is enforced

| Place | Function | What it does |
| --- | --- | --- |
| Every page in `src/app/(app)/` | `requirePageAccess("<key>")` | verifies session + allowlist, evaluates the page's rule, redirects to `/no-access` if refused. |
| The `(app)` layout | `accessiblePages(principal)` | filters the rail tabs, the gear menu and the "New" menu to what the rule allows. This is presentation; the page check above is the boundary. |
| Every operator route in `src/app/api/v1/admin/` | `adminHandler(fn, { endpoint: "<key>" })` | authenticates, resolves the allowlist row, loads the endpoint's rule, refuses with 403 `forbidden` (or 503 when disabled), then runs the handler. |
| Inside pages | `canDo(capabilities, "<action>")` | greys out or hides controls. Not a boundary; the API re-checks. |

### Where a page is drawn

The access map decides *who* may open a page; it does not decide *where* the
shell puts it. That is the `section` field on each entry in
`src/lib/admin-access/page-registry.ts`: `main` (the default) puts a page on
the left rail, `settings` puts it in the gear menu beside the bell in the nav
bar. The `(app)` layout splits the pages `accessiblePages` returned into those
two lists and hands both to the shell, so an operator only ever sees a gear row
they are allowed to open — the same filter the rail gets.

The section is code, not data, on purpose: moving a page from the rail into the
gear menu is a layout decision the build owns, and it changes nothing about the
page's route, its key or its rule. User Management is the one page under
Settings today; everything else, Customers included, is on the rail.

`auth_kind` on an endpoint says whether the map applies at all: `public`
endpoints (health, the auth routes) and `session` endpoints (`/api/v1/me`,
any signed-in Cognito user) are listed for documentation but are not gated by
the map.

### Editing rules

**Access Map** page (needs `can_manage_access_map` to open, super-admin to
save). Two lists: pages & quick actions, and API endpoints. Open a row to
change: enabled, super-admin only, the any-of actions, name, description, rail
order (pages) or operator notes (endpoints). Every save writes an audit event
(`page_rule_updated`, `endpoint_rule_registered`, …).

### Adding a page or endpoint

1. Write the route. Pages call `requirePageAccess("<key>")`; routes export
   through `adminHandler(fn, { endpoint: "<key>" })` (or `apiHandler` /
   `protectedHandler` with `{ endpoint }` for public and session endpoints).
2. Add the entry to the matching registry with sensible defaults. Pages also
   choose a `section` (rail or gear menu) and get an icon in
   `src/components/shell/definitions.ts`.
3. Deploy. The entry appears on the Access Map as **Not registered**; press
   **Register** (or **Register Missing**), then adjust the rule. Or add an
   `INSERT` to a new numbered file in `docs/sql/`.

Until step 3 the page or endpoint is reachable by super-admins only.

## The audit trail

`admin_permission_audit_events` receives a row for every membership, grant and
rule change, with the actor, a verb, the target and details. It is shown on
User Management → Audit log. It is append-only; nothing in the app deletes
from it.

## Safety rails in the repositories

Whichever repository is active, these hold: emails and role keys are unique;
system roles cannot be deleted; a role with members cannot be deleted; an
operator cannot disable or demote themself; the last enabled super-admin
cannot be disabled or demoted. Violations come back as 409 `conflict` or 422
`validation_failed`.
