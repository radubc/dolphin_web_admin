# Overview

The page at `/`, where sign-in lands: what the account is spending, how the
customer base is moving, and whether the deployment is healthy. Six cards, one
server render, no client JavaScript of its own.

The code is `src/app/(app)/page.tsx` (the grid and the reads),
`src/components/overview/` (the cards, all Server Components) and
`src/lib/ops/` (the two AWS reads and their cache). The research it was built
from is
[cost-usage-and-customer-stats-plan.md](./cost-usage-and-customer-stats-plan.md),
section 5.

## How it renders

- **Server-rendered in one pass.** Every card's data is a `src/lib/*` function
  called directly. The page never `fetch`es this app's own API: that would be a
  round trip to re-authenticate an operator who is already authenticated here.
  There is therefore **no `/api/v1/admin/ops` endpoint and no endpoint-registry
  entry** — there is nothing on the page for a browser to call. Access is the
  page rule alone, `requirePageAccess("overview")`, which every operator on the
  allowlist has by default (`PAGE_REGISTRY`, `requireSuperAdmin: false`).
- **Seven reads, all independent.** `Promise.allSettled` runs them
  concurrently and each card is handed a `Loaded<T>`: the data, or the sentence
  to print instead. A card whose read failed shows `Not available: <reason>`
  and nothing else on the page changes. **The Overview never throws** — a
  dashboard that 500s because CloudWatch was unreachable is a worse outage
  than the one it is reporting.
- **What the reason says depends on where the read went.** Every read is
  handed to `loadedFrom` with its source (`src/app/(app)/page.tsx`), and:
  - an **AWS** failure prints AWS's own message (`Could not load credentials
    from any providers`, an `AccessDenied` naming the action) — that sentence
    is the one that ends the investigation;
  - a **database** failure prints `The admin database could not be read.`,
    `The main database could not be read.`, or — for the two cards that read
    both and cannot know which refused — `The admin or the main database could
    not be read.` A Prisma message is a paragraph of connection, model and
    driver detail: useful in a log, not on a dashboard, and the one class of
    message that could carry infrastructure detail to a screen. The full
    detail is logged server-side with an `[overview]` prefix and the read's
    name.
- **No interactivity, no client bundle.** Nothing here has state, so none of
  the cards is a Client Component (which also rules out Ant Design, whose
  components and icons are client-only). A refresh is the browser's refresh.
- **Not a list page.** The grid scrolls in the shell's `<main>`, as this page
  always has. `ListPageFrame` exists so a table's rows are the only thing that
  moves, and there is no table here.

## The cards

| Card | Reads | Freshness |
| --- | --- | --- |
| **This month** | `getCostSummary()` and `getCostDaily(2)` from `src/lib/costs/service.ts`: month to date, Cost Explorer's forecast, yesterday's total, and the AWS budget's actual against its limit | as fresh as the last `aws_costs` run (daily). **Nothing here calls Cost Explorer** — it charges $0.01 a request; see [costs.md](./costs.md) |
| **Customers** | `customerHeadline()` from `src/lib/customers/statistics.ts`: accounts, 30-day active users, new and departed this month, churn | accounts come from last night's `cognito_directory` snapshot (live `users` rows until the first run); the rest is live |
| **Activity funnel** | `overviewFunnel()` in `src/lib/ops/overview.ts`, which composes `accountCensus()` and `funnelProgress()` exactly as the Customers page's Activity view does: invited → confirmed → onboarded → first transaction → first attachment | the first two steps are the nightly pool snapshot, the last three are live |
| **Operations** | `getOperationsMetrics()` in `src/lib/ops/metrics.ts`: one `cloudwatch:GetMetricData` call, 24 hours at one-hour resolution, with a sparkline per metric | cached 60 s in-process |
| **Deployments** | `getDeployHealth()` in `src/lib/ops/deploy.ts`: one `ecs:DescribeServices` call — running against desired tasks, task definition revision, rollout state, newest service event | cached 60 s in-process |
| **Largest tenants** | `overviewLargestTenants()` → `largestTenants(5)`: the five tenants holding the most live `file_blobs` bytes | live, main app database, no AWS call |

Both AWS calls are **free**. The whole page costs two AWS requests a minute at
most, however many operators have it open, and zero dollars.

The funnel and the customer figures are the deliberately cheap subset of the
Customers page's statistics: definitions of record for churn, MAU, "invited"
and the rest live in `src/lib/customers/statistics.ts` and are explained in
[customers.md](./customers.md). Nothing is redefined here.

## Environment variables

All six are **optional**, and that is the point: if any were unset the row
would say `not set` and name the variable, and the rest of the page would be
unaffected. In practice `infra/service-admin.yaml` sets five of the six —
four from names the stacks already know, and `OPS_ALB_ARN_SUFFIX` from the
`OpsAlbArnSuffix` template parameter, because ECS Express creates the shared
load balancer and its name cannot be predicted ahead of time. The sixth,
`OPS_AWS_REGION`, is deliberately left unset: it falls back to `AWS_REGION`,
which Fargate always sets. They are read in `src/lib/ops/config.ts`, per
request, never at module load.

| Variable | What it is | Value in this deployment |
| --- | --- | --- |
| `OPS_AWS_REGION` | the region the metrics and the ECS services live in. Falls back to `AWS_REGION`, which Fargate always sets. **Not** `us-east-1`: that pin belongs to Cost Explorer alone | `us-west-2` |
| `OPS_RDS_INSTANCE_ID` | the `DBInstanceIdentifier` dimension | `fairsums-<env>` (`infra/environment.yaml`) |
| `OPS_ECS_CLUSTER` | the `ClusterName` dimension and the `DescribeServices` cluster | `fairsums` (the foundation stack's `ClusterName`) |
| `OPS_ECS_SERVICES` | comma-separated `ServiceName` values, in the order the card lists them. At most ten, which is also `DescribeServices`' limit | `fairsums-web-<env>,fairsums-admin-<env>` |
| `OPS_ALB_ARN_SUFFIX` | the `LoadBalancer` dimension: the tail of the balancer's ARN, `app/<name>/<id>`. A whole ARN is accepted and cut down; anything that does not look like the tail is treated as unset, because a wrong dimension returns an empty series that reads as "no traffic" | ECS Express creates the balancer, so the name is not predictable — take it from the `LoadBalancerArn` output of either service stack (`aws elbv2 describe-load-balancers`). One balancer serves **both** apps, so these three rows cover the web app and the console together |
| `OPS_WAF_WEBACL_NAME` | the `WebACL` dimension. The `Region` dimension is the region above and `Rule` is `ALL`, the whole-ACL aggregate | `fairsums-admin-<env>` — the only web ACL; it fronts the shared balancer and its default action is Allow |

Wrong values fail quietly by design: CloudWatch answers an unknown dimension
with an empty series rather than an error, so the row shows `no data` and the
card cannot tell that apart from "this has never happened". Check a new value
once against `aws cloudwatch get-metric-data` when you set it.

## The metrics, and where they turn amber

One `GetMetricData` call carries every row. Thresholds live in
`METRIC_THRESHOLDS` (`src/lib/ops/types.ts`) so the card and any future alarm
cannot disagree; the server decides the colour, the card only paints it.

| Row | Namespace / metric | Statistic | Judged on | Warn | Critical |
| --- | --- | --- | --- | --- | --- |
| Database → Free storage | `AWS/RDS` `FreeStorageSpace` | Minimum | newest hour | below 2 GiB | below 1 GiB |
| Database → Connections | `AWS/RDS` `DatabaseConnections` | Maximum | newest hour | 35 | 60 |
| Database → CPU | `AWS/RDS` `CPUUtilization` | Average | newest hour | 80% | 95% |
| Containers → CPU, Memory (per service) | `AWS/ECS` `CPUUtilization`, `MemoryUtilization` | Average | newest hour | 80% | 95% |
| Load balancer → Target 5xx | `AWS/ApplicationELB` `HTTPCode_Target_5XX_Count` | Sum | 24-hour total | 1 | 25 |
| Load balancer → Requests | `AWS/ApplicationELB` `RequestCount` | Sum | — | never | never |
| Load balancer → Response time | `AWS/ApplicationELB` `TargetResponseTime` | Average | newest hour | 1 s | 3 s |
| Firewall → Blocked requests | `AWS/WAFV2` `BlockedRequests` (`Rule=ALL`) | Sum | — | never | never |

Two of those numbers are worth explaining:

- **Connections warn at 35, critical at 60.** The research note suggested
  eight, on the arithmetic that `DATABASE_POOL_MAX` is 5 and the admin
  container builds two pools (main and admin database) against the web
  container's one — a ceiling of fifteen for the deployment. Two measurements
  moved it:

  1. **Measured 2026-09-12, the stage instance peaks at 19 with both apps
     close to idle.** Already above the fifteen our own pools can hold:
     pgAdmin, the integrations scheduler and whatever else holds a session
     account for the rest. Eight — or twenty — would paint the card amber
     permanently, and an always-amber card is one nobody reads.
  2. **A rolling deployment doubles every pool.** ECS starts the new task
     before draining the old one, so for a minute or two both are connected
     and fifteen becomes thirty. A threshold under that is amber on every
     deploy.

  So 35 means something beyond our own pools and a deploy is holding
  connections (a second environment on the instance, a pgAdmin session left
  open, a pool that is not releasing), and 60 is approaching the ~85 a
  `db.t4g.micro` allows. Change the constants in `METRIC_THRESHOLDS`, not the
  card, if the pool sizes or the instance class change — and re-measure.
- **Requests and blocked requests never warn.** They are context, not alarms:
  the request count is what makes the 5xx count mean something, and the WAF
  blocking traffic is the admin host's allowlist doing its job.

Every row also carries a 24-hour sparkline (`src/components/overview/sparkline.tsx`,
one inline SVG path, no charting library). An hour CloudWatch published nothing
for is a **gap**, not a zero, and the line is broken there: "nothing happened"
and "nothing was measured" are different facts.

### Why a row can be empty

| Shown | Means |
| --- | --- |
| `not set` | the variable naming that resource is unset; the note says which one |
| `no data` | the metric exists but nothing was published in 24 hours. Normal — no 5xx means no `HTTPCode_Target_5XX_Count` datum at all |
| `—` with a sentence at the top of the card | the `GetMetricData` call itself failed; the sentence is AWS's own message (`Could not load credentials from any providers`, an `AccessDenied`, …) |

## Deployments, and the missing image tag

Per configured service: running against desired tasks, the task definition
`family:revision`, the primary deployment's rollout state (`COMPLETED`,
`IN_PROGRESS`, `FAILED`) and its reason, and the newest service event — which
is where a rollout that is failing explains itself ("unable to place a task",
"health checks failed").

**There is no image tag.** It lives inside the task definition's container
definitions, which needs `ecs:DescribeTaskDefinition`; the task role is granted
`ecs:DescribeServices` and nothing else (`infra/service-admin.yaml`), so the
revision stands in and the card says so. Until that permission is added, "which
commit is running" comes from the deploy workflow, which stamps the SHA into
`BUILD_ID`.

A service ECS does not return — a typo in `OPS_ECS_SERVICES`, a service in
another cluster — gets its own row with ECS's own failure reason, instead of
disappearing.

## IAM

Already granted by the `operations-metrics-read` policy in
`infra/service-admin.yaml`; nothing to add:

- `cloudwatch:GetMetricData` on `*` (it has no resource-level permissions).
  **That is the only CloudWatch action granted.** `cloudwatch:ListMetrics` was
  in the policy until 2026-09-12 and was never called — it omits metrics that
  have been quiet for a fortnight, exactly the ones a young deployment has,
  while `GetMetricData` answers for a metric that has never been published
  with an empty series — so it was removed rather than left for an audit to
  ask about.
- `ecs:DescribeServices` on `*` (scoping it would mean importing the cluster
  ARN into this stack for both services).

Credentials come from the SDK's default provider chain — the ECS task role on
Fargate, a profile or the `AWS_*` variables locally — exactly as the Cognito
and Cost Explorer clients do. Nothing in `src/lib/ops/` reads, holds or logs a
credential.

## The 60-second cache

`src/lib/ops/cache.ts`. The Overview is the page an operator lands on and then
leaves open, so both AWS reads are memoised per process for a minute:

- One minute is shorter than the resolution of anything on the card — the
  metric period is an hour, a rollout takes minutes — so a cached answer is
  never misleading, and both cards print when they were read.
- **Failures are cached too.** A missing credential does not fix itself inside
  a minute, and retrying on every render would turn one misconfiguration into a
  stream of failing calls. After a fix the wait is at most sixty seconds.
- Concurrent renders share the in-flight promise: a cold cache and three open
  tabs is still one AWS call. The cache is per process, so two tasks keep two —
  the same trade the rate limiter makes.
- **A hung socket cannot hold the page.** Both clients are built with
  `OPS_CLIENT_TIMEOUTS` (`src/lib/ops/cache.ts`): a 5-second request timeout,
  a 2-second connection timeout and `maxAttempts: 2`. The Overview is
  server-rendered, so an AWS call that never answers does not degrade one card
  — it holds the whole response open, and the 60-second cache would then serve
  every render the same stuck promise. Both numbers are far above what these
  calls take from Fargate in the same region (tens of milliseconds) and far
  below any patience a dashboard deserves.

## Verifying it without AWS

The page degrades in three steps, and all three can be seen locally:

1. **Nothing configured** (no `OPS_*`, no `AWS_REGION`): every Operations row
   reads `not set` with the variable's name, Deployments shows the same
   sentence, and the call is never made (`requests: 0`).
2. **Configured, no credentials**: both cards show AWS's own message
   (`Could not load credentials from any providers`).
3. **Configured with credentials**: real figures, and any dimension that does
   not exist shows `no data` rather than zero.

The cards themselves need only the page: `npm run dev`, sign in, open `/`. A
card whose data source is down prints its reason, which is the same path a
broken AWS configuration takes.
