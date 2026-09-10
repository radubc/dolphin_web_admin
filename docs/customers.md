# Customers

The people who use the consumer app. **Customers** (`/customers`) lists them,
says how active each one is, and is where an operator invites someone new —
the consumer app has no self-service sign-up, so every account starts here.

The code is `src/lib/customers/`; the API is `/api/v1/admin/customers/*`
(listed in [api.md](./api.md)); the one table it owns is created by
[`docs/sql/010_customers.sql`](./sql/010_customers.sql). Everything else is
read from two places this app does not own: the **main app database** (the
consumer app's data) and the **customer Cognito user pool** (the pool real
people sign in to, which is *not* the admin pool operators sign in to).

## Where each figure comes from

| Column | Source | Notes |
| --- | --- | --- |
| Email, created, updated | `users` in the main app database | The row the consumer app writes the first time a Cognito identity signs in. |
| Tenants | `user_tenants` → `tenants`, live rows only | The primary tenant is marked. A brand-new customer can have none yet. |
| Last active | the greatest `updated_at` across the tenant's live `transactions`, `accounts`, `budgets` and `goals`, falling back to `tenants.updated_at` | "Someone changed something in this household", not "someone signed in" — the admin app cannot see sign-ins. |
| Accounts, Transactions | live row counts per tenant | How far the person actually got. Zero and zero is a customer who signed in once and stopped. |
| Status | the customer Cognito pool | `active` (confirmed and enabled), `invited` (still on the temporary password), `disabled` (the pool account is switched off), `no_account` (a `users` row whose `sub` is not in this pool), `unknown` (the pool was not consulted, or answered with a state this page has nothing to say about). |
| Total / Active in the last 30 days | main app database | Live `users` rows; and how many of them belong to a tenant that changed anything in the window. |
| Invited / Disabled | the customer Cognito pool | Counted over the whole pool, so they include people who have never signed in and therefore have no `users` row. Both read 0 when the pool cannot be consulted. |

Two things are worth being precise about:

- **Reads only.** Nothing in this feature writes to the main app database. The
  invitation records live in the admin database; acceptance is *detected* by
  reading `users` and recorded here.
- **One pool listing per request.** The pool is paged through once
  (`ListUsers`, 60 at a time) and cached in-process for 60 seconds, rather
  than asking Cognito once per row. That is a deliberate trade for a small
  pool: past roughly 12 000 accounts the listing is cut short, the counts say
  so in the server log, and the approach has to be replaced by a per-`sub`
  filter.

If the pool cannot be consulted — not configured, no AWS credentials, an IAM
refusal — the list still answers from the database with `cognito: null`,
`status: "unknown"` and `cognitoAvailable: false`. A *list* that fails because
Cognito is unhappy would be worse than one that says what it does not know.

The customer pool marks two attributes as required: `name` and `locale`. The
invite drawer asks for both up front (locale defaults to `en-US`) so an
accepted invitation is not immediately asked to fill in gaps Cognito already
required at account creation, but neither is required by the invite form
itself: whatever an operator leaves blank there, the pool asks the person to
supply at their first sign-in instead. Neither value is stored in
`admin_customer_invites` — the pool holds them, the same way it holds the
account's password.

## How an invitation works

1. An operator enters an email address, optionally a name and a locale (see
   above), and optionally a note for their own record: "beta tester", "friend
   of X".
2. A row is written to `admin_customer_invites` with status `invited` —
   **before** Cognito is called, so a failure leaves a trace.
3. `AdminCreateUser` creates the account in the customer pool with the email
   marked verified, the `name` / `locale` attributes when given, and
   `DesiredDeliveryMediums: ["EMAIL"]`. Cognito generates a temporary password
   and emails it. **This app never sees that password**, and nothing about it
   is stored or logged.
4. The person receives Cognito's invitation email: their username (the email
   address) and the temporary password, which expires after the pool's
   configured window (7 days by default).
5. They sign in to the **consumer app** with those two, and Cognito requires
   them to set their own password before it issues any token.
6. On the first successful sign-in the consumer app writes a `users` row
   carrying the account's `sub`. The next time anyone opens Customers, that
   `sub` is matched against the open invitations and the row flips to
   `accepted`, dated by the `users` row's `created_at`.

**Resend** re-issues the temporary password and sends the email again
(`MessageAction: "RESEND"`); it only applies while the invitation is still
open, and it bumps `sendCount` / `lastSentAt`.

**Revoke** withdraws an invitation nobody has used: the pool account is deleted
and the row is kept as `revoked`. It refuses (409) the moment the account is
anything other than `FORCE_CHANGE_PASSWORD` — a person who has signed in is a
customer with data, and deleting them is not something this page does.

**A refused create** leaves the row as `failed` with Cognito's reason, and the
operator sees it in the list. A retry is a *new* invitation, not a repair of
the old one, so the history of what was attempted stays intact. Only one
**open** invitation per address can exist at a time; the database enforces it
with a partial unique index on `lower(email)`.

Creating, resending and revoking each write an `admin_permission_audit_events`
row (`target_type = 'customer_invite'`, the email in the metadata).

## Known gap: an invited person cannot finish signing in yet

Cognito answers the first sign-in of an invited account with the
`NEW_PASSWORD_REQUIRED` challenge. The consumer app does not implement that
challenge — `~/Developer/projects/penny-squeeze-web/src/lib/auth/cognito.ts`
(around line 156) turns any challenge into

> This account requires an extra step (a new password) that isn't supported yet.

So today an invitation can be created, delivered and revoked, but the person
**cannot complete sign-in** until the consumer app answers that challenge with
`RespondToAuthChallenge`. Until then, treat the invite flow as ready on this
side and blocked on the other. Nothing in the admin app can work around it: the
challenge has to be answered by the app the person is signing in to.

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `CUSTOMER_COGNITO_USER_POOL_ID` | for anything Cognito | The **consumer app's** user pool id. It has no fallback on purpose: falling back to `COGNITO_USER_POOL_ID` would point invitations at the admin pool. Unset, the page works from the database alone and the invite form is replaced by the reason it cannot send. |
| `CUSTOMER_COGNITO_REGION` | no | Falls back to `ADMIN_COGNITO_REGION`, then `AWS_REGION`, then `NEXT_PUBLIC_COGNITO_REGION`. |
| AWS credentials | for anything Cognito | Not read by this app. Every `Admin*` call is SigV4-signed and the AWS SDK resolves credentials from its default chain: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN`), a shared profile, or an instance/task role. Prefer a role in production. |

A missing pool id is reported as `canSend: false` with the reason. Missing or
insufficient credentials can only be discovered by making a call, so they
surface as 503 `cognito_unavailable` on the action the operator took, with a
message saying the deployment's AWS credentials or IAM permissions do not
allow it. The real AWS error is in the server log with a `[customers]` prefix;
credentials are never logged.

## IAM permissions

The identity the app runs as needs exactly these, on the **customer** pool's
ARN (`arn:aws:cognito-idp:<region>:<account>:userpool/<CUSTOMER_COGNITO_USER_POOL_ID>`):

| Action | Used by |
| --- | --- |
| `cognito-idp:ListUsers` | the status column and the Invited / Disabled counts |
| `cognito-idp:AdminCreateUser` | sending an invitation, and resending it |
| `cognito-idp:AdminGetUser` | checking an account is still unused before a revoke |
| `cognito-idp:AdminDeleteUser` | revoking an invitation |

Nothing here needs `AdminSetUserPassword`, `AdminDisableUser` or
`AdminUpdateUserAttributes`, and the policy should not grant them: this console
cannot change a customer's password, disable their account or edit their
profile, and the permissions should say so.

The pool must also be able to send email (Cognito's default sender is
rate-limited; a real deployment configures SES).

## Tables

| Table | Database | Read | Written |
| --- | --- | --- | --- |
| `users`, `user_tenants`, `tenants` | main app | yes | **never** |
| `transactions`, `accounts`, `budgets`, `goals` | main app | counts and `max(updated_at)` only | **never** |
| `admin_customer_invites` | admin | yes | yes |
| `admin_permission_audit_events` | admin | — | one row per invitation change |

The main database role sees every tenant, which is why the tenant-scoped
tables can be aggregated from here at all. Locally that is the `postgres`
superuser; on Amazon RDS, where no role can carry `BYPASSRLS`, it is the
master user, which owns the restored tables and is therefore exempt from
row-level security on every table that does not say FORCE ROW LEVEL SECURITY
(`categories` had FORCE dropped for this reason; see the consumer repo's
`docs/postgres/2026-09-10_categories_owner_access.sql`). Every query in `src/lib/customers/repository.ts`
is a `findMany`, `findFirst`, `count` or `groupBy`; there is no write path to
the consumer app's data in this feature, by construction.

## What it does not do

- No editing of a customer, their tenants or their data.
- No disabling or deleting a customer's account. Revoke only removes a pool
  account that has never been used.
- No password reset on someone's behalf, and no way to read a temporary
  password: Cognito generates and mails it, and this app never receives it.
- No sign-in history. "Last active" is derived from the data the person's
  tenants changed, because that is what the databases record.
