# Customers

The people who use the consumer app. **Customers** (`/customers`) has three
views: **Customers** lists them and says how active each one is,
**Invitations** is where an operator invites someone new — the consumer app
has no self-service sign-up, so every account starts there — and **Activity**
is how the population is moving: active users, arrivals, departures, churn,
retention, the invitation funnel and the largest tenants.

The code is `src/lib/customers/`; the API is `/api/v1/admin/customers/*`
(listed in [api.md](./api.md)); the tables it owns are created by
[`docs/sql/010_customers.sql`](./sql/010_customers.sql) (invitations) and
[`docs/sql/014_customer_statistics.sql`](./sql/014_customer_statistics.sql)
(the three history tables behind Activity). Everything else is read from two
places this app does not own: the **main app database** (the consumer app's
data) and the **customer Cognito user pool** (the pool real people sign in to,
which is *not* the admin pool operators sign in to).

## Where each figure comes from

| Column | Source | Notes |
| --- | --- | --- |
| Email, created, updated | `users` in the main app database | The row the consumer app writes the first time a Cognito identity signs in. |
| Tenants | `user_tenants` → `tenants`, live rows only | The primary tenant is marked. A brand-new customer can have none yet. |
| Last seen | `users.last_seen_at` in the main app database | The consumer app stamps it at sign-in and refreshes it at most once an hour. The only fact in either database that means **the person themselves** was present. Null for a row written before the column existed, or for someone who has not signed in since. |
| Last active (the line under it) | the greatest `updated_at` across the tenant's live `transactions`, `accounts`, `budgets` and `goals`, falling back to `tenants.updated_at` | "Someone changed something in this household", not "someone signed in". This is what the console could measure before `last_seen_at` existed; it is kept as the fallback and is always labelled, so the two are never mistaken for each other. |
| Accounts, Transactions | live row counts per tenant | How far the person actually got. Zero and zero is a customer who signed in once and stopped. |
| Cost (est.) | `admin_tenant_cost_monthly` in the admin database, summed over the customer's tenants for the current month | An **allocated estimate**, not a bill: the month's AWS spend split into four pools and divided by measured usage by the nightly `allocate_costs` run. One request serves the whole column, and it is best-effort — an operator without a cost action, or a deployment where `docs/sql/015_cost_allocation.sql` has not run, sees a dash with the reason. The drawer shows the last two months with the four components. See [cost-allocation.md](./cost-allocation.md). |
| Status | the customer Cognito pool, except `deleted` | `active` (confirmed and enabled), `invited` (still on the temporary password), `disabled` (the pool account is switched off), `deleted` (`users.deleted_at` is set — the consumer app's delete-my-account flow; it outranks everything the pool says), `no_account` (a `users` row whose `sub` is not in this pool), `unknown` (the pool was not consulted, or answered with a state this page has nothing to say about). Because `deleted` outranks the pool, a **status filter other than "all" leaves the soft-deleted rows out** even with "Include deleted" on: a row matching `status=active` would otherwise arrive labelled `deleted`, and the filter and the row would disagree on screen. `status=deleted` is how to ask for them, and it selects them alone. |
| Total / Active in the last 30 days | main app database | Live `users` rows; and how many of them belong to a tenant that changed anything in the window. |
| Invited / Disabled | the customer Cognito pool | Counted over the whole pool, so they include people who have never signed in and therefore have no `users` row. Both read 0 when the pool cannot be consulted. |
| Deleted | main app database | Soft-deleted `users` rows. Hidden from the list unless "Include deleted" is on (or `status=deleted` is chosen), so the header figure is the only place they are counted without going looking. |

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

## Activity: how the population moves

The third view answers the questions a list cannot: how many people are
actually using the product, how many arrived last month, how many left, and
where a new person stalls. None of it can be read live, because **neither
system that holds the facts keeps the history**:

- Cognito's `ListUsers` answers "who is in the pool right now" and nothing
  else. There is **no event and no Lambda trigger for a deletion or a
  disablement** — an account removed yesterday is simply absent from today's
  answer, with nothing saying it ever existed. Per-user activity is a Plus
  tier feature ($0.020 per monthly active user, no free allowance) and this
  deployment is on Essentials.
- The main app database knows who signed in (`users.last_seen_at`), how much
  they used the product (`usage_daily`) and who deleted their account
  (`users.deleted_at`), but nothing about someone who was invited and never
  got that far.

So the admin app keeps its own history in three tables, filled once a night by
the `cognito_directory` integration. **The difference between two snapshots is
the event log.**

### The three tables

| Table | What it holds | Written by |
| --- | --- | --- |
| `admin_customer_snapshots` | One row per pool account per day the job saw it, keyed `(sub, seen_on)`: the pool's status (lower-cased, otherwise untouched), `enabled`, the pool's own created/modified dates, the email, and `partial` — true when the listing behind that day was cut short. | the job only |
| `admin_customer_events` | The lifecycle log: `invited`, `confirmed`, `disabled`, `enabled`, `deleted`, `reappeared`, `deleted_in_app`, each with `at`, a `source` and free-form `details`. | the console's invite and revoke actions (`source: console`), the nightly diff (`directory_diff`), the nightly main-database sweep (`main_db`) |
| `admin_pool_metrics_daily` | The pool's `AWS/Cognito` CloudWatch counters per UTC day: sign-ins, sign-in attempts, sign-ups, token refreshes, throttles. | the job only |

Snapshot rows are **never pruned**, and that is the point: the absence of a
sub on a later day is the deletion, so a pruned history would erase the
evidence. At a few thousand accounts it grows by a few thousand narrow rows a
night. A retention policy — keep the first snapshot of each month past a year,
say — is a later decision, not an emergency.

Every writer is **idempotent**, because `UNIQUE (sub, event, at)` is combined
with a deterministic `at`: the diff dates its events at 00:00 UTC of the
snapshot day, and the main-database sweep dates a deletion at
`users.deleted_at` itself. Running the job twice in a night, or re-reading the
same week of deletions seven nights running, writes nothing new.

### The nightly run

`cognito_directory`, daily at 02:30 America/Toronto, four parts, each
committed before the next begins. (`docs/sql/014_customer_statistics.sql`
seeds the row's `base_url` as `https://cognito-idp.us-west-2.amazonaws.com`
for orientation on the Integrations page only. **Nothing reads it**: both SDK
clients build their own endpoint from `CUSTOMER_COGNITO_REGION`, so the region
in that URL is cosmetic and editing it changes nothing — including which
region the CloudWatch metrics are read from.) **Every call it makes is free** — there is
no equivalent of Cost Explorer's per-request charge anywhere on this path — so
"Take snapshot" on the Activity view carries no price warning, unlike the Cost
center's refresh.

1. **Snapshot.** Page `ListUsers` (60 at a time) and write today's rows,
   replacing anything an earlier run wrote for the same day. A listing the
   page cap cut short is written with `partial = true`.
2. **Diff** against the most recent previous **complete** snapshot day, and
   only if the change between the two is small enough to be believable.
3. **Metrics.** One `GetMetricData` call for the last `metricsDays` days
   (default 35, cap 450 — what CloudWatch keeps at a one-day period), at an
   86 400-second period, ending yesterday. Today's bucket is deliberately left
   out: a fraction of a day of sign-ins reads as a collapse. The queries are
   metric-math `SEARCH` expressions, for the reason below.
4. **The consumer-app deletion sweep.** Everyone whose `users.deleted_at`
   falls in the last 7 days and has no `deleted_in_app` event yet gets one,
   dated at the deletion itself so the departure lands in the month it
   happened in. This is what makes a self-service account deletion count as
   churn the same night, rather than waiting for the pool clean-up.

### The diff rules

Applied between the previous snapshot day and today's:

| Condition | Event |
| --- | --- |
| a sub was in the previous snapshot and is not in today's | `deleted` |
| `enabled` went true → false | `disabled` |
| `enabled` went false → true | `enabled` |
| status went `force_change_password` → `confirmed` | `confirmed` |
| a sub is in today's snapshot and was not in the previous one | `reappeared` |

Four things about them are deliberate:

- **The first snapshot writes no events at all.** With nothing to compare
  with, every existing account would look like an arrival, inventing a
  month's worth of signups on the night the feature was switched on.
- **A truncated listing is never diffed, and never diffed *against*.** The
  pool read is capped at 12 000 accounts (`LIST_PAGE_CAP` in
  `src/lib/customers/cognito.ts`). If the cap is hit, the snapshot is still
  written — partial data is still data — but the day is marked
  `partial = true`, the diff is refused, and the run **fails** with a message
  saying so, because every account the listing did not reach would otherwise
  be recorded as deleted. The mark matters the *next* night too:
  `previousSnapshotDay()` skips partial days, so a truncated day can never
  become the previous side of a diff. The diff then reaches further back
  instead, which is exactly what it already does for a night the job did not
  run.
- **A change too large to be real is refused, not recorded.** "A sub was here
  yesterday and is not today" is also what a *different* pool looks like, and
  a `deleted` event is permanent — it is the churn figure, and nothing later
  can tell it from a real departure. So before the diff is believed, two
  shapes fail the run and keep the snapshot
  (`diffRefusal()` in `src/lib/integrations/jobs/cognito-directory.ts`):

  | Condition | Why |
  | --- | --- |
  | today's listing is empty and the previous snapshot was not | every account in the pool would be recorded as deleted |
  | the count dropped by **more than half** *and* by **more than 20 accounts** | either alone is ordinary — a pool of three losing two is a 67 % drop, and 20 departures out of 2 000 is a busy week; together they are not something the product can do to itself overnight |

  Both messages name `CUSTOMER_COGNITO_USER_POOL_ID`, because a pool id that
  changed is the likeliest cause. If the drop is real, the next night's
  snapshot narrows the gap and the diff resumes.
- **`confirmed` fires on the transition, not on the state.** "Is now
  confirmed" would fire for every account that was already confirmed when
  snapshots began.
- **A new sub is `reappeared`, not "new".** A genuinely new account looks
  exactly like a night the job did not run. The event name says only what is
  certain. Real arrivals are `invited` (written by the console at the moment
  it creates the account) and, for counting purposes, `users.created_at`,
  which a missed night cannot confuse.

### The definitions behind each figure

All of it is measured in **UTC**: a UTC calendar month and a UTC day, because
both databases store timestamps with a zone and a Toronto month would put the
same sign-in in different months on either side of midnight.

| Figure | Definition |
| --- | --- |
| Accounts, and the by-status breakdown | The newest snapshot day, `partial` or not — what a truncated listing did reach is real. Cognito's own `UserStatus`, lower-cased and otherwise untouched: a status the console has nothing to say about (`EXTERNAL_PROVIDER`, `ARCHIVED`, whatever AWS adds next) is **recorded**, not flattened to `unknown`, and the page labels the ones it knows and prints the rest verbatim. Only the *list* column narrows the status to the six states it can act on. |
| DAU / WAU / MAU | Live `users` rows whose `last_seen_at` is inside the last 1 / 7 / 30 days. **Not sign-ins** — someone signed in for a week is one active user and one sign-in. |
| New per month | `users.created_at`: the first time the consumer app saw the person. An invitation nobody accepted is not a customer. |
| Deleted per month | `deleted` **and** `deleted_in_app` events, deduped per sub within the month. Someone who deletes their account in the app and then disappears from the pool the same night is one departure. **A pool deletion is attributed to the month of the snapshot that noticed it**, not to the month it happened in: the diff dates its events at 00:00 UTC of the snapshot day, because that is all it knows — Cognito has no deletion event, so an account removed on the 31st and first missed on the 1st lands in the new month, and a night the job did not run pushes it further still. `deleted_in_app` is different: it is dated at `users.deleted_at` itself, so a self-service deletion always lands in the month it happened in. |
| Churn per month | `deleted ÷ activeAtStart`, where `activeAtStart` is everyone who existed and had not been deleted at 00:00 UTC on the 1st, plus anyone seen in the 30 days before it. A month that began with nobody is `null`, **not 0 %**. |
| Retention by sign-up month | Of everyone whose `users` row was created in month M, the share with a `last_seen_at` inside the last 30 days **and** no `deleted_at`. A deleted account stays in the cohort and can never be retained, so a cohort that left reads as retention falling. |
| Funnel | `invited` and `confirmed` from the newest pool snapshot; `onboarded` (a live `user_tenants` row), `firstTransaction` (the tenant holds ≥1 live transaction) and `firstAttachment` (≥1 live `file_blobs` row) from the app database. |
| Sign-ins per day | `admin_pool_metrics_daily.sign_ins` — `SignInSuccesses` `Sum`, summed over the pool's app clients (see the CloudWatch note below). `sign_in_attempts` is the same metric's `SampleCount`, so attempts minus sign-ins is the failures: Cognito publishes one datum per call with a value of 1 for a success, which holds per app client and therefore holds for the sum over them. |
| Requests / errors per day | `usage_daily`, summed over every tenant. Today is included and is drawn lighter: it is still being counted. |
| Largest tenants | Live `sum(file_blobs.byte_size)` and live `count(transactions)` per tenant, top ten each. No AWS call and no cost allocation — this is data volume, not money. |

### What the figures cost, and what is cached

Two parts of the answer are the expensive half: the churn denominators are one
`users` count per month in the window, and the largest-tenant tables aggregate
`file_blobs` and `transactions` across every tenant. Both are cached **in
process for ten minutes** (`CUSTOMER_STATS_CACHE_TTL_MS` in
`src/lib/customers/statistics.ts`), which is shorter than the resolution of
what they hold — "who existed on the 1st" and total data volume are not
figures that move inside ten minutes. Nothing per-operator is part of a cache
key, so nothing can leak between operators, and the cheap parts (DAU/WAU/MAU,
the census, the funnel, the two daily series) are **not** cached: an
invitation or a sign-in shows up on the next load. The Overview's customer
card shares the churn-denominator cache, so whichever screen is opened second
pays nothing for it.

The two range knobs on the view mostly cost nothing either. A payload for 24
months and 90 days already contains the 6-month, 14-day answer as a suffix, so
narrowing is done in the browser (`src/lib/customers/window.ts`); widening,
**Refresh**, and a payload older than ten minutes all still ask the server.

**A note for the consumer app's owner, not a change to make here.** Two
columns this feature leans on have no leading index in the main database:
`users.last_seen_at` (every DAU/WAU/MAU count and the retention numerator
filter on it) and `usage_daily.user_id` (the per-customer usage in the
activity drawer; the table's indexes lead with `tenant_id`). Both are
sequential scans today, which is invisible at a few thousand users and will
not stay that way. The admin app must not touch that schema — it belongs to
the consumer app — so this is recorded here rather than acted on.

**One honest imprecision.** The churn numerator is counted over Cognito subs
and the denominator over `users` rows. A revoked invitation is a `deleted`
event for someone who never had a `users` row, so a month full of revocations
reads as churn against a base that never included them. The alternative —
only counting departures whose sub is known to the app database — would
silently drop the deletions that matter most, such as an account removed in
the AWS console, so the simpler definition is kept and stated here instead.

**A second, smaller one.** Deduplication is *per sub per month*. Someone who
deletes their account on the 31st and disappears from the pool on the 1st is
counted twice, once in each month.

### What is empty when

| State | What the Activity view shows |
| --- | --- |
| `014_customer_statistics.sql` has not run | 503 `admin_schema_missing` on the **statistics** endpoint: every pool-derived figure on it depends on tables that do not exist, and drawing zeros instead would be inventing measurements. The rest of the Customers page is unaffected, the per-customer **activity** endpoint included — it is mostly main-database figures, so a missing `admin_customer_events` answers with an empty lifecycle log (`eventsForSub` is the one read in `lifecycle.ts` that tolerates the missing table, and it logs one line per process saying which file to run). |
| The SQL has run, the job has not | The account census, the funnel's first two steps and the sign-ins chart are empty, with an alert saying so. Active users, new, deleted (from console-written events), churn, retention, usage and the tenant tables all answer — they need no job. |
| The job ran once | Everything answers. Churn and deletions only cover what the event log has seen, so the first month or two is thin by construction; it is not wrong, it is young. |
| CloudWatch is refused by IAM | Snapshot and diff succeed, the metrics part is recorded as a skip with the reason, and the run does **not** fail. The chart stays empty until the permission is added. |
| CloudWatch answers, but with nothing | Every query empty across the whole window is reported as a **failed** metrics part — with the dimensions and the pool id to check — but only when the pool holds at least one confirmed account. A pool of invitations nobody has accepted really does produce no sign-ins, and a young deployment must not be told its metrics are broken when they are merely quiet. A `StatusCode` other than `Complete`, and anything in the answer's `Messages`, always end up in the run's error text: neither ever arrives as an exception, so a run that ignored them would report success over an answer AWS had reservations about. |

### Extra IAM for the nightly job

On top of what the Customers page already needs:

| Action | Resource | Used by |
| --- | --- | --- |
| `cognito-idp:DescribeUserPool` | the customer pool ARN | pool-level facts (`EstimatedNumberOfUsers`, the tier). Permitted in `infra/service-admin.yaml`; the job does not call it yet — `ListUsers` is the directory and gives an exact count. |
| `cloudwatch:GetMetricData` | `*` (CloudWatch has no resource-level permission for it) | the daily sign-in, sign-up, refresh and throttle counters. This is the **only** permission the metrics part needs: the queries are metric-math `SEARCH` expressions, and a search is evaluated inside `GetMetricData` rather than through a second API. |
| ~~`cloudwatch:ListMetrics`~~ | `*` | **removed 2026-09-12**, never used. It omits metrics that have been quiet for two weeks, which are exactly the ones a young pool has, and `SEARCH` already answers "whichever of these series exist" in the same request. `docs/sql/014_customer_statistics.sql` still lists it as a requirement in its header comment; it never was one. |

The CloudWatch region is the **pool's** region, from `CUSTOMER_COGNITO_REGION`
— not `us-east-1`. Unlike Cost Explorer (a global service reached there
whatever the task's region), CloudWatch metrics live in the region that
produced them, and asking the wrong region returns an empty answer rather than
an error, which is the worst failure mode available.

### Why the metric queries are search expressions

`AWS/Cognito` publishes **per app client, never for the pool on its own**:
every series in the namespace carries both a `UserPool` and a
`UserPoolClient` dimension. A `GetMetricData` query that names `UserPool`
alone therefore matches no series at all and answers with an empty set — not
an error, an empty set, which reads as "nobody signed in". So each counter is
asked for as one metric-math expression over both dimensions, summed across
whatever app clients the pool has:

```
SUM(SEARCH('{AWS/Cognito,UserPool,UserPoolClient} MetricName="SignInSuccesses" UserPool="<pool id>"', 'Sum', 86400))
SUM(SEARCH('{AWS/Cognito,UserPool,UserPoolClient} MetricName="SignInSuccesses" UserPool="<pool id>"', 'SampleCount', 86400))
SUM(SEARCH('{AWS/Cognito,UserPool,UserPoolClient} MetricName="SignUpSuccesses" UserPool="<pool id>"', 'Sum', 86400))
SUM(SEARCH('{AWS/Cognito,UserPool,UserPoolClient} MetricName="TokenRefreshSuccesses" UserPool="<pool id>"', 'Sum', 86400))
SUM(SEARCH('{AWS/Cognito,UserPool,UserPoolClient} MetricName="SignInThrottles" UserPool="<pool id>"', 'Sum', 86400))
```

Three things follow. `SUM` across app clients is what a pool-wide "sign-ins
per day" means, and an app client added later is picked up with no code
change. The third `SEARCH` argument is the period, so the series arrive
already bucketed by UTC day. And the `Sum` / `SampleCount` pair still works:
one datum per call with a value of 1 for a success holds per app client, so
attempts minus successes is the failures for the sum too. The pool id is
checked against `^[A-Za-z0-9_-]+$` before it is put in the expression — a
value outside that alphabet is a misconfiguration, not something to escape,
and the run says so naming the variable. A `SEARCH` needs no permission
beyond `cloudwatch:GetMetricData`.

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
| `users.last_seen_at`, `usage_daily` | main app | yes | **never** |
| `file_blobs`, `documents` | main app | counts and `sum(byte_size)` only | **never** |
| `admin_customer_invites` | admin | yes | yes |
| `admin_customer_snapshots` | admin | yes | one row per pool account per night |
| `admin_customer_events` | admin | yes | the console's invite/revoke actions, the nightly diff, the nightly main-database sweep |
| `admin_pool_metrics_daily` | admin | yes | one row per UTC day, nightly |
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
- No per-user sign-in history. "Last seen" is one timestamp, not a log:
  Cognito publishes per-user auth events only on the Plus tier ($0.020 per
  monthly active user, no free allowance) and this deployment is on
  Essentials. Pool-wide sign-ins per day are free and are on the Activity
  view; who signed in when is not available at any price we are paying.
- No attribution for a deletion. The nightly diff knows an account is gone,
  not who removed it. CloudTrail's `LookupEvents` would answer that (90 days
  of event history, free, two requests a second) and is the natural next step
  if "who deleted this account" ever matters.
