# Costs

What the AWS account is spending, how the console learns it, and what it costs
to ask. The page is `/cost-center`; the code is `src/lib/costs/`, the job is
`src/lib/integrations/jobs/aws-costs.ts`, and the tables are created by
[`docs/sql/013_aws_costs.sql`](./sql/013_aws_costs.sql).

The research this was built from is
[cost-usage-and-customer-stats-plan.md](./cost-usage-and-customer-stats-plan.md);
section 2 is the design and section 4 explains why "cost per client" is an
allocation rather than a bill.

## The one rule

**Nothing but the daily job calls AWS about money.** Cost Explorer charges
**$0.01 per request** and its data lags about a day, so a page that asked on
every load would cost more than some of the resources it reports on and would
not be any fresher. The page and both endpoints read `admin_cost_daily` and
`admin_cost_snapshots` and nothing else.

The only way to spend money from the UI is the Cost center's **Refresh now**,
which starts the same job by hand. Its tooltip says the price, and the button
is drawn only for an operator with `can_write_integrations` — the action that
governs the run endpoint it calls. Everyone else sees "Refresh not permitted"
with the reason in a tooltip, and the cached figures below it.

## Before it can work

Two account settings, neither of which is SQL and neither of which this app
can do for you. Both take up to 24 hours and **neither is retroactive**.

1. **Enable Cost Explorer.** Open AWS Billing and Cost Management → Cost
   Explorer once. Until then every `ce:*` call answers
   `DataUnavailableException`, and the run fails with a message saying exactly
   this and what to do. No IAM change is involved.
2. **Activate the cost allocation tags.** Billing → Cost allocation tags →
   activate `Application`, `Environment` and `Component`. Every resource in
   the three CloudFormation stacks already carries all three, but a tag does
   nothing for billing until it is activated, and activation only affects
   spend incurred from then on. Until it is done the page's "By component"
   card says so rather than showing an empty table; after it is done, the
   months before it will still never split.

Optional but recommended: create one **Cost Anomaly Detection** monitor (AWS
services, account scope). It is free. Without one the Anomalies card is
permanently empty, which looks exactly like "nothing went wrong".

Two things about that card either way. `GetAnomalies` filters its date
interval on the anomaly's **end** date, so an anomaly AWS still considers open
— no end date yet — may not be returned at all, however recent it is; the
window therefore reaches to *tomorrow* rather than today, and the card is best
read as "what has finished going wrong". A row that *does* arrive with no end
date is labelled "still open". And an empty card is never proof that all is
well.

Also optional: an **AWS Budget**. With one, the header band shows a meter of
`CalculatedSpend` against the limit — Budgets' own arithmetic, not ours,
because a budget can be scoped and filtered in ways this app does not model
and the number in the alert email is AWS's. With several budgets, set
`settings.budgetName` on the integration to pick one; otherwise the first one
`DescribeBudgets` returns is used.

## IAM

`infra/service-admin.yaml`, the admin task role, policy `cost-and-usage-read`,
statement `CostAndUsageRead`. Resource is `*`: Cost Explorer and Free Tier
have no resource-level permissions at all, and **Budgets does** — a budget
ARN — but the two Budgets reads are granted account-wide on purpose, because
the job reads whichever budget `settings.budgetName` names (or the first one
the account has) and a per-budget ARN would need a redeploy every time a
budget was created or renamed.

| Action | For |
| --- | --- |
| `ce:GetCostAndUsage` | the daily series and the component split |
| `ce:GetCostForecast` | today to the end of this month |
| `ce:GetDimensionValues`, `ce:GetTags` | valid service names and tag values (not called yet; here so a filter can be added without a deploy) |
| `ce:GetAnomalies` | Cost Anomaly Detection findings |
| `budgets:ViewBudget`, `budgets:DescribeBudgets` | the budget meter |
| `freetier:GetFreeTierUsage`, `freetier:GetAccountPlanState` | the free-tier card |

`ce:GetAnomalyMonitors` was in the first draft of this policy and nothing ever
called it, so it has been removed. The page shows the *findings*, not the
monitors; add the permission back with the code that needs it.

`sts:GetCallerIdentity` needs no permission — no policy can deny it — and is
how the account id that `DescribeBudgets` requires is resolved, memoised for
the life of the process. That is why no `AWS_ACCOUNT_ID` variable exists.

The same template also adds `operations-metrics-read`
(`cloudwatch:GetMetricData`, `ecs:DescribeServices`,
`cognito-idp:DescribeUserPool` on the customers' pool). **Nothing in this
feature uses it**; it is there so the operations card and the
customer-statistics page, which are the next two items in the plan, do not
each need their own deploy.

Credentials always come from the AWS SDK's default provider chain — the ECS
task role on Fargate, a profile or the `AWS_*` variables locally — exactly as
`src/lib/customers/cognito.ts` does for Cognito. No cost-related environment
variable exists and none is needed.

## The job

`aws_costs`, a normal entry on the Integrations page: it has a schedule, a
settings object, a run history, and a "Run now" button. Seeded by
`docs/sql/013_aws_costs.sql` at **daily, 09:00 America/Toronto** — not the
small hours the market-data jobs use, because Cost Explorer settles the
previous day some hours into it and a 01:00 run would read a figure it then
had to correct.

Settings (`admin_integrations.settings`, editable on the Integrations page):

| Key | Default | Meaning |
| --- | --- | --- |
| `days` | `35` | how far back the daily fetch reaches, ending yesterday. Clamped to **120**: every page of the answer is a charged request, every day, and days already fetched stay in the cache anyway |
| `componentTag` | `Component` | the cost allocation tag the month split is grouped by (at most 128 characters, AWS's own limit on a tag key) |
| `budgetName` | unset | which budget to read when the account has several. Empty means the first one `DescribeBudgets` returns |

All three are edited in the Integrations drawer's **Cost Explorer** section,
alongside the schedule, and validated on the server by
`integrationPatchSchema` with the same bounds the reader clamps to.

`requires_api_key` is false and `api_key_env` is null: the credential is the
task role. The row's `base_url` is shown for orientation and is read by
nothing — the SDK builds its own endpoint.

### What one run does

Today is the run date in **UTC**; Cost Explorer's `End` is exclusive
everywhere, and no *historical* call asks about today, whose spend AWS has not
totalled. The forecast is the one exception, and has to be: its `Start` may be
no later than today.

| # | Call | Window | Charged | Skipped when |
| --- | --- | --- | --- | --- |
| a | `GetCostAndUsage` DAILY, group by SERVICE, `Not RECORD_TYPE in (Credit, Refund)` | `[today - days, today)` | $0.01 per page | never |
| b1 | `GetCostAndUsage` MONTHLY, group by SERVICE **and** TAG `componentTag`, same filter | `[1st of this month, today)` | $0.01 per page | today is the 1st (the month has no completed day) |
| b2 | the same call for the **previous** month | `[1st of last month, 1st of this month)` | $0.01 per page | today is the 4th or later |
| c | `GetCostForecast` `UNBLENDED_COST` MONTHLY | `[today, 1st of next month)` | $0.01 | never planned as a skip; Cost Explorer itself may refuse for want of history |
| d | `GetAnomalies` | the last 35 days to tomorrow, inclusive | free | never |
| e | `budgets:DescribeBudgets` | the account | free | the account has no budget (recorded as a skip) |
| f | `freetier:GetAccountPlanState` + `GetFreeTierUsage` | the account | free | not on a free plan, or `freetier:*` is not granted |

So **three charged Cost Explorer requests a run**, and a fourth on the 1st,
2nd and 3rd of a month: about **$0.03 a day and roughly $1 a month** at one
run a day. A pressed "Refresh now" is the same again; the page rounds it up to
"about five cents" because an operator pressing a button deserves the
pessimistic number. `MAX_PAGES` in `src/lib/costs/explorer.ts` caps the paging
at eight pages per call — 35 days of about fifteen services fits in one page,
so the cap is a spending stop, not a working limit — and a run that *does* hit
it is a **failed** run rather than a quiet one (see below).

Two group-by keys is the maximum Cost Explorer allows, and (b1)/(b2) use both:
grouping by the tag alone would leave `service` with nothing meaningful in it,
and the rows go into the same `(day, service, component)` table as (a).

**Why (b2) exists.** A split window can only reach yesterday, so the last day
of a month is never inside one while that month is current. Re-asking for the
whole of the previous month once it has ended covers it, and doing so for the
first three days rather than only on the 1st allows for the day or two AWS
takes to settle a month's tail. From the 4th it is not asked again: the answer
cannot change and the request is not free.

**The forecast's window starts today, not tomorrow.** `GetCostForecast`
requires a `Start` equal to or earlier than the current date; asking from
tomorrow earns a `ValidationException`, which is what this job used to do — it
spent the request, recorded a skip, and left the forecast permanently null
under a green tick. `[today, 1st of next month)` also closes the gap the old
pair of windows left: month to date ends yesterday, so **today** belonged to
neither. Month to date plus forecast is now the month exactly once. On the
last day of a month the window is that single day, and on the 1st the month to
date is empty and the forecast alone is the projection.

### Writes

- **(a)** replaces every `component IS NULL` row in `[today - days,
  yesterday]`. Replace, not merge: Cost Explorer revises recent days and
  today's answer is the only one worth keeping.
- **(b1)** replaces every `component IS NOT NULL` row in `[1st, yesterday]`
  and **(b2)** every one in `[1st of last month, last day of last month]`,
  each stamped with its month's 1st as the `day` because the figure describes
  the month. Only the range asked for is touched, so **older component rows
  are history and stay** — the by-component card is a month's split, but the
  table behind it keeps every month it ever fetched. A tag value of `''` —
  spend the tag does not cover — is stored as the empty string and shown as
  "Untagged", which stays distinct from the `NULL` that marks the by-service
  series.
- **A replace that would lose data is refused.** If the fetch was truncated by
  the page cap, or came back empty for a window that already holds rows,
  nothing is deleted and nothing is inserted: the cached rows stay and the
  call is counted as **failed**, with the reason in the run's error. Cost rows
  cost $0.01 each time they are fetched, and an empty answer to a question
  that had an answer yesterday is far more likely to be a bad request than a
  free month.
- Amounts are `NUMERIC(14,6)`. AWS bills to six decimals and the job drops
  rows that come to zero, so four decimals turned a $0.000004 line into no row
  at all — a service that costs a few cents a month looked free.
- One `admin_cost_snapshots` row per run, always, even when a call failed: its
  `raw` column records which calls were made, which were skipped or failed and
  why, the windows they used, and how many **charged** Cost Explorer requests
  were spent — including the pages of a call that then threw, because a page
  that was sent was paid for.

The unique key is `UNIQUE NULLS NOT DISTINCT (day, service, component)`, which
Prisma cannot express — to Prisma two NULL components look distinct — so the
writes delete-then-insert inside one transaction rather than upserting. See
the comment at the top of `src/lib/costs/repository.ts`.

### Counters and failure

Unlike every other integration this run does not process a list, so its run
counters mean something slightly different, which the run drawer's numbers
should be read with:

- `total` — calls **planned** (a call the calendar makes meaningless is never
  planned: on the 1st there is no completed day to split, so (b1) is not
  planned; from the 4th (b2) is not. A run plans six calls most days, seven on
  the 2nd and 3rd);
- `processed` — calls that came back, answering or refusing;
- `failed` — calls that refused for a reason worth attention. "This does not
  apply to this account" is a **skip**, not a failure;
- `created` / `updated` — `admin_cost_daily` **rows** inserted with no
  previous reading, and rows that replaced one.

Failure policy:

- **Credentials or IAM** (`AccessDenied`, an expired token, no credential at
  all) throws immediately for `ce:*` and `budgets:*`: every further call would
  spend a request to learn the same thing. `freetier:*` is exempt — it is the
  one optional permission, and an account past the free tier refuses it too.
- **Cost Explorer not enabled** (`DataUnavailableException` on the very first
  call) throws with its own sentence naming the console click that fixes it.
  On any *other* call the same exception keeps its ordinary meaning — "this
  question does not apply here", most often too little history to forecast —
  and is a skip.
- **Not applicable** (`ResourceNotFoundException`, `NotFoundException`,
  `UnknownMonitorException`, and `DataUnavailableException` past the first
  call) is a **skip**: no budget, no free-tier plan, no forecast to be made.
- **An invalid request** (`ValidationException`,
  `InvalidNextTokenException`) is a **failure**, not a skip. AWS is saying the
  window or the parameters this job built were wrong; waiting does not fix it,
  the request was spent learning it, and the figure it should have produced is
  now missing. Its message goes into the run's error text, where nobody has to
  read a snapshot's `raw` to find it.
- **A refused or truncated write** is a failure too, for the same reason: the
  page is left showing something other than what AWS holds.
- **Anything else** is counted, recorded in the snapshot's `raw`, and rethrown
  as the run's `error` **at the end** — after the rows and the snapshot are
  written, so a run that got three answers out of four still leaves those
  three on the page.

## What the numbers mean

- **USD, always.** AWS bills this account in USD; nothing here converts
  currency. A budget whose limit is in another currency is recorded as-is and
  noted in the snapshot's `raw` rather than converted.
- **`UnblendedCost`** — what the account was actually charged for the usage.
- **Credits and refunds excluded.** These are *usage* figures, which is what a
  forecast and a per-tenant allocation have to be built on. **The invoice can
  be lower.** The one exception is the forecast: `GetCostForecast` accepts only
  a narrow set of filters and `Not RECORD_TYPE` is not among the documented
  ones, so it is sent unfiltered — and its window starts today, because that
  API refuses a `Start` later than the current date.
- **Nothing measured for today**, so on the 1st of a month the month-to-date
  figures are genuinely zero and the bars still show the previous month. Today
  is not simply dropped, though: it is the first day the *forecast* covers, so
  the projected month total accounts for it.
- **Six decimals.** `amount_usd` is `NUMERIC(14,6)`, because AWS bills to six
  and the job drops rows that come to zero — at four decimals a $0.000004 line
  became no row at all, and a service costing a few cents a month looked free.
- **`estimated`** marks a day AWS has not finalised; the chart draws it in a
  lighter tint of the same colour and it is expected to change.
- **"Last 30 days"** in the service table is a *rolling* window ending
  yesterday, not last calendar month, because the question it answers is "is
  this costing more than it was" and a calendar month cannot answer that on the
  2nd.

## Cost per client

AWS bills per resource and every resource except an S3 object is shared by all
tenants, so no AWS API can return a tenant's cost. A per-client figure can
only ever be an **allocation** of the month's bill over measured per-tenant
usage, labelled as an estimate.

The measurement now exists — `usage_daily` (requests, errors, sync rows, bytes
uploaded per tenant per day) and `users.last_seen_at` are both live in the main
app database — so the allocation is **built**: the nightly `allocate_costs`
integration splits each recent month's cached bill into four pools (shared
capacity, storage, data transfer, Cognito), divides each by a measured driver,
and writes `admin_tenant_cost_monthly`. The page's rail card shows the pool
totals and the ten most expensive tenants, with the full table behind "See
all"; `GET /api/v1/admin/costs/per-client` is the endpoint; the Customers page
carries the same figure per customer.

That run makes **no AWS call and costs nothing** — both its inputs are already
in the two databases — but it needs this page's `aws_costs` job to have cached
the month first, and it fails that month with a message saying so if it has
not. The model, the pools map, the two invented constants and the caveats are in
[cost-allocation.md](./cost-allocation.md); the table is created by
[`docs/sql/015_cost_allocation.sql`](./sql/015_cost_allocation.sql).

## Access

The page is keyed `cost_center` in `src/lib/admin-access/page-registry.ts`
(the path is `/cost-center`; `admin_pages.key` refuses a hyphen) and is
super-admin only until a role is granted on the Access Map. The two endpoints
are registered with `can_read_costs` (either cost action, ANY-OF).

**"Refresh now" is governed by `can_write_integrations`**, not by a cost
action: it starts the run through `POST
/api/v1/admin/integrations/aws_costs/run`, which is the Integrations
endpoint's rule. There is deliberately no second run-now endpoint for costs —
one job, one way to start it, one run history. `can_write_costs` is seeded
beside `can_read_costs` and is reserved for a cost-only write later.

The route reads the operator's capabilities (`requirePageAccess` →
`capabilitiesOf`) and passes them into the page, exactly as Integrations and
Customers do, so the button is not drawn for anybody who would only get a 403
from pressing it. That is presentation; the endpoint checks the action
again.

## Endpoints

Both are reads of the cache and are documented in [api.md](./api.md).

| Key | Route | Answers |
| --- | --- | --- |
| `admin.costs.summary` | `GET /api/v1/admin/costs` | `{ snapshot, byService, byComponent, lastRun }` |
| `admin.costs.daily` | `GET /api/v1/admin/costs/daily?days=35` | `[{ day, totalUsd, estimated, services }]` |

Until `013_aws_costs.sql` has run both answer 503 `admin_schema_missing`.
Afterwards, and before the job has ever succeeded, they answer 200 with
`snapshot: null` and empty lists — the page reports that as "no data yet"
rather than as zero spend.

## Files

| Path | What |
| --- | --- |
| `src/lib/costs/types.ts` | the wire model and the formatting helpers (client-safe) |
| `src/lib/costs/calendar.ts` | UTC day arithmetic; Cost Explorer's exclusive `End` lives here |
| `src/lib/costs/aws.ts` | the three clients (region pinned to `us-east-1`), the account id, and the error classification |
| `src/lib/costs/explorer.ts` | one function per AWS call, returning plain data |
| `src/lib/costs/repository.ts` | the admin-database reads and writes |
| `src/lib/costs/service.ts` | the two endpoint shapes, and the windows every figure is measured over |
| `src/lib/costs/schemas.ts` | the `?days=` query schema |
| `src/lib/costs/client.ts` | the browser's typed calls |
| `src/lib/costs/allocation.ts` | **cost per client**: the pools map, the pure allocator (micro-dollars, largest remainder), the driver reads and `admin_tenant_cost_monthly` — see [cost-allocation.md](./cost-allocation.md) |
| `src/lib/integrations/jobs/allocate-costs.ts` | the nightly allocation run; no AWS call |
| `src/components/cost-center/cost-per-client-*.tsx` | the rail card, the "See all" drawer, and the figures the Customers page borrows |
| `src/lib/integrations/jobs/aws-costs.ts` | the run body |
| `src/components/cost-center/` | the page: frame and ribbon, the SVG bar chart, the tables and rail cards, the data hook |
