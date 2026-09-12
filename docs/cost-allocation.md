# Cost per client

What one customer costs us, why that figure can only ever be an **estimate**,
and exactly how it is computed. The table is `admin_tenant_cost_monthly`
(created by [`docs/sql/015_cost_allocation.sql`](./sql/015_cost_allocation.sql)),
the model is `src/lib/costs/allocation.ts`, the job is
`src/lib/integrations/jobs/allocate-costs.ts`, and it is shown on the Cost
center's **Cost per client** card (and its "See all" drawer) and on the
Customers page's **Cost (est.)** column and customer drawer.

The research this was built from is section 4 of
[cost-usage-and-customer-stats-plan.md](./cost-usage-and-customer-stats-plan.md).
The bill it divides up is [costs.md](./costs.md).

## Why it is an estimate, and always will be

AWS bills per **resource**. Every resource this product runs on — the two ECS
services, the RDS instance, the load balancer, NAT, WAF, Route 53, Secrets
Manager, the log groups — is one resource used by every tenant at once. No API
answers "which rows of this shared database cost what": not Cost Explorer, not
Data Exports (CUR 2.0), not a cost allocation tag, because **there is no
per-tenant tag and there cannot be one** — tenants are rows, not resources.

The single exception is S3, where attachments really do live under
`tenants/<tenantId>/files/`, and even there summing `file_blobs.byte_size` in
the main database is exact, free, and cheaper than S3 Storage Lens.

So the honest answer is an allocation: split the month's bill into pools by
what drives each service's cost, and divide each pool by a driver that is
actually measured. Every surface says "Allocated estimate" in those words, with
a tooltip explaining the model. Nobody should ever quote one of these figures
as an invoice line.

## The pools map

`classifyService()` in `src/lib/costs/allocation.ts`. Keys are Cost Explorer's
exact `SERVICE` strings, matched case-insensitively, with a few substring rules
as a fallback.

| Pool | Services | Driver per tenant |
| --- | --- | --- |
| **fixed** (shared capacity) | Amazon Elastic Container Service, AWS Fargate, ECR, `EC2 - Other` (NAT, EBS, public IPv4), Amazon EC2 - Compute, Amazon VPC, Elastic Load Balancing, **Amazon Relational Database Service**, AWS WAF, Amazon Route 53, AWS Secrets Manager, AWS Certificate Manager, AWS KMS, AmazonCloudWatch, AWS CloudTrail, AWS Cost Explorer, AWS Budgets, Amazon SNS, AWS Systems Manager, AWS Lambda, Tax — **and anything not recognised** | activity weight = `requests + sync_rows`, after every tenant still live at the end of the month is given a floor |
| **storage** | Amazon Simple Storage Service, S3 Glacier, EFS, AWS Backup | `storage_bytes` |
| **request** | AWS Data Transfer, Amazon CloudFront, Amazon API Gateway | `requests` |
| **user** | Amazon Cognito (and "Amazon Cognito User Pools") | `active_users` |

Three things about that table are deliberate:

- **An unknown service goes to `fixed`.** A new line on the bill must not
  vanish from the allocation — that would make the per-client figures add up to
  less than the invoice, silently. "Shared capacity, split by how much each
  tenant used the product" is the least wrong assumption available for
  something we know nothing about. The Cost center's by-service table is where
  an operator notices the new name; adding it to the map is a one-line change.
- **RDS is entirely `fixed`, storage included.** Cost Explorer's `SERVICE`
  dimension does not separate instance hours from allocated storage; that needs
  the `USAGE_TYPE` dimension, which would be another charged request every day.
  And the volume is provisioned at a fixed size whoever is using it, so
  treating it as capacity is closer to the truth than splitting it by bytes.
- **The `request` pool is usually empty.** This account's data transfer sits
  inside the free allowance, and what is charged arrives inside `EC2 - Other`.
  The pool exists so that the day a transfer line appears it is divided by
  requests instead of landing in shared capacity. While it is empty and no
  tenant has a driver for it, it is reported as `unallocatedUsd` rather than
  smeared over the tenants.

## The drivers

Read from the **main app database** (read-only, as everything this console does
to the consumer app's data is) for each tenant the month concerns:

| Driver | How | Caveat |
| --- | --- | --- |
| `requests`, `sync_rows` | `usage_daily` summed over the month's days | Zero until the consumer app records usage. |
| `activity_weight` | `requests + sync_rows` | One definition, in `activityWeightOf()`. A sync row counts the same as a request: both are one trip through the same containers and the same database connection. |
| `storage_bytes` | live `sum(file_blobs.byte_size)` **plus 512 bytes per live `transactions` row** | **Current**, not historical — see below. |
| `active_users` | distinct users of the tenant with `users.last_seen_at` inside the month, **union** anyone with a `usage_daily` row in it | Either is evidence a person was there, and Cognito billed for them. |

"The month concerns" a tenant if it is live, **or** was deleted during or after
that month: its usage was real and was paid for, and dropping it after the fact
would move its share onto everyone else. A tenant deleted before the month
began never had a row.

**Who carries the floor is a narrower question.** Only a tenant that was still
live at the **end of the month's window** does (`liveAtMonthEnd`). A tenant
deleted mid-month keeps every share its measured drivers earn it — the
requests were made, the capacity was used — but it is not charged a floor for
capacity that was standing by for it after it was gone. A tenant deleted
*after* the month was live at that month's end, so it does carry the floor.

### The two invented numbers

1. **`TRANSACTION_ROW_BYTES = 512`.** The database footprint charged per live
   transaction row. It is the order of magnitude of one row of the consumer
   app's widest hot table with its indexes; the true figure depends on fill
   factor, TOAST and how many of the other tenant tables a household uses. It
   exists because storage allocated on attachments alone would say a tenant
   with 50 000 transactions and no receipts costs nothing to store, which is
   plainly false. Transactions are the one table that grows with use in every
   household, so they are the proxy.
2. **`fixedFloorShare = 0.005`** (`settings.fixedFloorShare`, capped at 0.25
   and additionally so that **the floors together take at most half the pool**:
   `0.5 / floor-eligible tenants`). The share of the shared-capacity pool every
   tenant still live at the end of the month carries before the remainder is
   split by activity. Without it a strictly usage-proportional split hands the
   whole bill to the busiest household and says a dormant one is free — but the
   capacity was provisioned for them too. At half a percent, twenty dormant
   tenants carry a tenth of the capacity between them and the measurement still
   decides the rest.

   The half-pool cap is what keeps that true as the product grows: 150 tenants
   at half a percent each would otherwise hand out 75 % of the shared capacity
   before a single measurement was looked at, and the figure would have become
   a headcount. When the cap binds, every eligible tenant's floor shrinks
   equally, so the ranking the measurement produces is untouched —
   `FIXED_FLOOR_POOL_SHARE_MAX` in `src/lib/costs/allocation.ts`.

### Storage is measured now, not then

`file_blobs` and `transactions` hold what a tenant has **today**; neither keeps
the size it had in June. So recomputing an old month moves its storage split as
data grows. That is why only the last two months are recomputed by default
(`settings.months`), and why a figure from six months ago should be read as
"what that month would have cost at today's data volumes".

## The arithmetic

Each pool is divided in integer **micro-dollars** (1 USD = 1 000 000) with a
largest-remainder (Hamilton) pass: every tenant gets the floor of its
proportional share, and the units left over go to the largest fractional
remainders, ties to the earlier tenant id. Therefore:

- the tenants' components sum to the pool **exactly**, to the micro-dollar;
- the answer is deterministic — a re-run does not move a cent between two
  identical tenants;
- `allocated + unallocated = the month's cached bill`, always.

The fixed pool is divided in one pass, not two: a tenant's weight is
`(floor if it was live at the month's end, else 0) + (1 - floor × eligible
tenants) × activity / totalActivity`, which sums to 1 by construction. With no
activity anywhere the remainder is split equally over **every** tenant — the
only defensible answer when nothing distinguishes them.

`share_pct` is the tenant's total as a percentage of the whole month's bill
(four decimals), clamped to ±999.9999 because the column is a
`NUMERIC(7,4)`. Shares need not sum to 100: a pool whose driver was zero for
every tenant stays unallocated. Two ways a share leaves 0..100 altogether:

- **a bill revised downwards** after the allocation was written — the rows are
  what they were, the total is smaller, and a share above 100 % is the honest
  reading of that until the next nightly run;
- **a negative pool.** A month dominated by a credit or a refund can total
  below zero at AWS, in which case every pool and every tenant's components
  are negative. The arithmetic holds — the largest-remainder pass floors, so
  it is exact for a negative total too — and the amounts read as the credit
  they are. The *shares* of such a month are a ratio of two negatives and so
  still read positive; a share genuinely goes below zero only in a **mixed**
  month, where one pool is a credit and another is spend, and the tenant's
  total ends up with the opposite sign to the month's. The clamp only stops
  any of these failing to write with a numeric overflow, which would lose the
  whole month's rows.

## The nightly run

`allocate_costs`, daily at **03:30 America/Toronto**, after `aws_costs`
(09:00 the previous day) and `cognito_directory` (02:30). A normal entry on the
Integrations page with a schedule, a run history and "Run now".

**It calls nothing.** No AWS request, no provider, no API key, no charge — both
inputs are already in the two databases. Its provider is recorded as `aws`
only because that is whose bill it divides: `admin_integrations_provider_chk`
has no `internal` value, and widening it (plus `INTEGRATION_PROVIDERS` and the
base-URL domain map) for a row whose `base_url` nothing reads was not worth it.

Settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `months` | `2` | Months recomputed, ending with the current (partial) one. Capped at 14 — what Cost Explorer keeps. |
| `fixedFloorShare` | `0.005` | The floor described above. Capped at 0.25, and at `0.5 / floor-eligible tenants`. |

Once per run, before the months: what every tenant holds **today** —
attachment bytes and live transaction rows (`tenantStorageNow()`). Neither
table keeps history, so those two aggregates of the consumer app's largest
tables are the same answer for every month in the window; reading them per run
rather than per month is what keeps a fourteen-month backfill from aggregating
them twenty-eight times.

Then per month, oldest first: read the cost by service (`component IS NULL`
rows only — the by-component rows are the same money counted a second way),
fold it into the pools, read the month's four driver aggregates, allocate, then
upsert the rows on `(tenant_id, month)` and delete any row for that month whose
tenant the recomputation did not cover. That delete is what keeps the promise
that a month's rows sum to the month's bill.

**One transaction per month, which is exactly the promise.** The upserts and
the stale delete are the same edit seen from two sides, so they commit
together: a month either lands whole or not at all, and a month already
written stays written. The transaction is per month and never per run, so a
run interrupted half way leaves every month it had finished intact.

**An empty allocation never overwrites a written month.** If the tenant read
comes back with nothing while the month already has rows, the write is refused,
the rows are kept, and the month is counted as **failed** — "there are no
tenants" is a broken read, not news worth deleting a month of figures over. (A
month with no rows *and* no tenants is not refused: there is nothing to
protect.)

Counters, which mean what they mean for the other two AWS-adjacent jobs — parts
of a run, not items in a list:

- `total` — months planned; `processed` — months that finished;
- `failed` — months that could not be allocated, which today means two things:
  **no cached cost rows** (there is no bill to divide, and the run says "run
  aws_costs first"), or a **refused write** (the allocation covered no tenant
  at all while the month already had rows, so the existing figures were kept).
  That month fails and the others carry on, so a deployment where `aws_costs`
  has only just started still gets this month allocated;
- `created` / `updated` — rows written for the first time, and rows that
  replaced an earlier allocation;
- `unchanged` — months skipped because they have no completed day yet (a run on
  the 1st).

A run with any failed month fails, after everything else is committed: the page
would otherwise show a gap under a green tick. The per-month outcomes are
logged with an `[integrations] allocate_costs months:` prefix — this job has no
snapshot table to keep a `raw` column in.

**Nothing is counted for today**, on either side: the cost window and the
driver window both end yesterday, so a tenant's share is measured over exactly
the days it is charged for. On the 1st of a month the window is empty and the
month is skipped.

## The endpoint

| Key | Route | Answers |
| --- | --- | --- |
| `admin.costs.per_client` | `GET /api/v1/admin/costs/per-client?month=YYYY-MM` | `{ month, monthTotalUsd, pools: { fixedUsd, storageUsd, requestUsd, userUsd, unallocatedUsd }, tenants: [{ tenantId, tenantName, ownerEmail, totalUsd, fixedUsd, storageUsd, requestUsd, userUsd, sharePct, requests, storageBytes, activeUsers, deleted }], computedAt }` |

Most expensive tenant first. `month` defaults to the current UTC month and is
bounded to `2020-01 .. the month after this one` (422 outside that — a month
nobody is asking about should be refused at the boundary, not answered with an
empty table). The endpoint **never recomputes and never calls AWS**: it reads
`admin_tenant_cost_monthly`, sums the pool totals from `admin_cost_daily`, and
reads tenant names live from the main app database.

**`ownerEmail` is only filled in for an operator who may read the customer
directory** — `can_read_user_list` or `can_read_user_detail`. The cost actions
buy the figures, not the addresses behind them; without one of those two the
field is `null` and the membership read that would have produced it is never
made. The tenant's name is not gated: it is what the rows are labelled with,
and without it the table is a list of UUIDs.

The pool totals are recomputed per call rather than stored per month — one
`groupBy` of a small table — so that when the bill is revised but the
allocation has not been recomputed yet, the difference shows up as
`unallocatedUsd`, which is exactly where a reader should see it.

Until `015_cost_allocation.sql` has run it answers 503
`admin_schema_missing`. Afterwards, and before the job has ever run, it answers
200 with the pools it can read, `tenants: []` and `computedAt: null`; the page
says "not computed yet" rather than drawing zeros as measurements. Access is
the same as the other two cost endpoints: `can_read_costs` **or**
`can_write_costs` (ANY-OF), resolved through the `cost_center` page's actions.

## Where it is shown

| Surface | What | File |
| --- | --- | --- |
| Cost center rail card | The month's four pool totals, what is unallocated, the ten most expensive tenants, a month picker (last six), and "See all" | `src/components/cost-center/cost-per-client-section.tsx` |
| Cost center drawer | The full table: tenant and owner, total and share, the four components, and the three drivers. Only the rows scroll (`ListTableRegion`) | same file |
| Customers list | A **Cost (est.)** column: the current month summed over the customer's tenants | `src/components/customers/customers-view.tsx` |
| Customer drawer | The last two months, with the four components | `src/components/cost-center/cost-per-client-figures.tsx` |

The Cost center's card reads its own endpoint, so it is drawn **even when the
rest of the page's cost summary could not be read**: a failed `admin_cost_daily`
summary says nothing about whether the allocation can be shown, and hiding the
card with the rest of the rail hid the one card that could still answer.

The Customers surfaces are **best-effort**: an operator may hold the Customers
actions without holding a cost action, in which case the endpoint answers 403
and the column shows "—" with the reason in its tooltip. The column also shows
"—" for a month that has **not been allocated yet** (`computedAt: null`) rather
than `$0.00`: a month nobody has computed has no figures, and a zero would be a
measurement we do not have. One request per page serves the whole column —
never one per row, and never a join into the list's own query.

**One fetch per month per five minutes**, shared by every surface. The month
payloads are held in a module-level cache in
`src/components/cost-center/cost-per-client-data.tsx`
(`PER_CLIENT_CACHE_TTL_MS`), keyed by month: the customer drawer asks for two
whole months every time it opens, and without the cache a session spent
opening one customer after another re-downloaded the same two month tables per
click. Five minutes is far shorter than the data's own resolution — it moves
once a night — and a rejection is never cached, so a 403 that becomes a grant
is visible on the next read. The Cost center card's own reload control bypasses
it.

The customer-level figure is **summed over the tenants the person belongs to**.
The allocation is per tenant and a tenant can have several members, so a shared
household shows the same figure on both members' pages. The drawer says so.

## What it does not do

- **No revenue and no margin.** Once pricing exists, margin per client is this
  table joined with it — the reason `total_usd` is stored rather than derived.
- **No per-resource truth.** See the top of this page. If that is ever needed,
  Data Exports (CUR 2.0) into Athena is the path, and it still cannot split a
  shared database by tenant.
- **No alerting.** "This tenant costs more than they pay" is a question for the
  day there is a price.
- **No recomputation on demand from the page.** "Run now" on the Cost
  allocation integration is the way, and it is governed by
  `can_write_integrations` like every other run.
