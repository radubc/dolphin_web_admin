# Admin access control

Schema and seeds for the **admin-only** Cognito pool allowlist and a default-deny RBAC model.

- SQL: [`admin_access.sql`](./admin_access.sql)
- Target DB: `admin_penny_squeeze` (`ADMIN_DATABASE_URL`)
- RLS: **not used**. Authorization is enforced in the admin app.

## Model

```text
admin_users ──< admin_user_roles >── admin_roles ──< admin_role_actions >── admin_actions
                     │
                     └── admin_permission_audit_events (append-only)
```

| Table | Purpose |
|-------|---------|
| `admin_users` | Operators allowed to sign in (admin Cognito `sub` + email). |
| `admin_actions` | Atomic permissions (`can_read_tickets`, …). |
| `admin_roles` | Named bundles of actions. |
| `admin_role_actions` | Role → action grants. |
| `admin_user_roles` | User → role assignments. |
| `admin_permission_audit_events` | Audit trail for grants/revokes. |

**Effective permissions** for a non–super-admin user = union of all actions on all of their roles.

**Default deny:** if an action key is not in that set (and the user is not a super-admin), access is denied.

## Rules the app must enforce

1. After Cognito auth (admin pool only), load `admin_users` by `cognito_sub`.
2. No row, or `disabled_at IS NOT NULL` → deny (no session / no API access).
3. `is_super_admin = true` → allow all actions; only super-admins may manage users/roles/grants.
4. Otherwise require an explicit action key (e.g. `can_write_tickets`) on every route/UI control.
5. Re-check on **every request** (or short-lived session claims refreshed from DB), so removals take effect quickly.
6. Write an `admin_permission_audit_events` row for every membership or grant change.

Do not grant admin access based on the main app’s `users` table or the end-user Cognito pool.

## Apply the SQL

```bash
# From repo root; uses ADMIN_DATABASE_URL from .env
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/admin-access/admin_access.sql
```

Or with Prisma later: mirror these tables in `prisma-admin/schema.prisma`, then migrate — this SQL is the source of truth for the first cut.

## Bootstrap the first super-admin

1. Create the person in the **admin** Cognito user pool; note their `sub` and email.
2. Insert them (run once; replace placeholders):

```sql
INSERT INTO admin_users (cognito_sub, email, display_name, is_super_admin)
VALUES (
  'COGNITO_SUB_HERE',
  'you@example.com',
  'Main admin',
  TRUE
);
```

3. Sign in to the admin app with that Cognito user. Further admins should be created by this super-admin through the app (or SQL as break-glass).

There is no seeded super-admin in the SQL file on purpose.

## Add a regular admin with a role

```sql
-- 1) Allowlist the Cognito user
INSERT INTO admin_users (cognito_sub, email, display_name)
VALUES ('COGNITO_SUB_HERE', 'agent@example.com', 'CS Agent');

-- 2) Assign a seeded role
INSERT INTO admin_user_roles (user_id, role_id)
SELECT u.id, r.id
FROM admin_users u
CROSS JOIN admin_roles r
WHERE u.email = 'agent@example.com'
  AND r.key = 'customer_service_agent';
```

## Check effective permissions

```sql
SELECT action_key, action_category
FROM admin_user_effective_actions
WHERE email = 'agent@example.com'
ORDER BY action_category, action_key;
```

Super-admins will often have **no rows** in this view if they have no roles; that is expected — the app grants them everything via `is_super_admin`.

## Suggested app check (pseudo)

```ts
async function assertAction(cognitoSub: string, actionKey: string) {
  const user = await prismaAdmin.admin_users.findUnique({
    where: { cognito_sub: cognitoSub },
  });
  if (!user || user.disabled_at) throw new ForbiddenError();
  if (user.is_super_admin) return;

  const allowed = await prismaAdmin.$queryRaw`
    SELECT 1
    FROM admin_user_effective_actions
    WHERE cognito_sub = ${cognitoSub}
      AND action_key = ${actionKey}
    LIMIT 1
  `;
  if (!allowed.length) throw new ForbiddenError();
}
```

## Seeded roles (from SQL)

| Role key | Intent |
|----------|--------|
| `customer_service_agent` | Read users/tenants; full ticket workflow |
| `user_support_readonly` | Read-only users/tenants |
| `catalog_editor` | Read/write admin catalog data |

Add new `admin_actions` keys when you add UI/API surfaces; grant them only through roles (or super-admin).

## Security notes

- Use a **separate Cognito user pool** (and app client) for this admin app only; disable public sign-up.
- Keep `ADMIN_DATABASE_URL` credentials off the main consumer app.
- Prefer short sessions and deny on every request after allowlist/role changes.
- Log denials and successful privilege use for sensitive actions.
- Plan break-glass access (DB insert of a new super-admin) if the only super-admin is locked out.
