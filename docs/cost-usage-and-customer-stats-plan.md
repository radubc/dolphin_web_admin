# Cost, customer statistics and cost per client — research and plan

Date: 2026-09-12. Status: research only, no code changed. Owner decides which pages to build.

Sources: AWS documentation (Cost Explorer, Budgets, Cognito user pools, CloudWatch, CloudTrail, S3 Storage Lens), the AWS billing and Cognito skills, and a read of both repositories (`dolphin_web_admin`, `penny-squeeze-web`) on 2026-09-12.

## 1. Summary

Three things were asked for. What AWS offers for each, in one line:

| Question | Verdict | Why |
| --- | --- | --- |
| Daily AWS cost on the admin page | **Available now.** Cost Explorer API, one small IAM change, one daily job. | Costs $0.01 per API request; the data lags about a day. |
| Cognito user statistics, daily activity, deletions and churn | **Partly.** Pool-level sign-in and sign-up counts per day are free from CloudWatch. Per-user activity and deletion events are not something Cognito hands you cheaply. | Per-user activity needs the Plus tier ($0.020 per active user, no free tier). Nothing fires when a user is deleted. The reliable path is to record activity and lifecycle events in our own tables. |
| Real cost per client | **As an allocated estimate, yes. As a billed figure, no.** | AWS bills per resource, and every resource except S3 objects is shared by all tenants. We can allocate the monthly bill to tenants by measured usage once the web app records usage per tenant, which it does not do today. |

Recommended order of work, because each step feeds the next:

1. Per-tenant usage recording in the web app (a `usage_daily` table plus `users.last_seen_at`). Small change, no AWS dependency, and every other page needs it.
2. Costs page in the admin console (Cost Explorer, daily job, cached in the admin database).
3. Customer activity and churn (nightly Cognito directory snapshot, CloudWatch pool metrics, the ledger from step 1).
4. Cost per client (a nightly allocation over steps 1 to 3).

## 2. Daily AWS cost

### What the APIs give

| API | What it answers | Notes |
| --- | --- | --- |
| `ce:GetCostAndUsage` | Cost by day or month, grouped by service, usage type, or a cost allocation tag; filtered the same way. Up to two group-by keys per call. | $0.01 per request, per page. Use `UnblendedCost`; exclude `RECORD_TYPE` Credit and Refund. End date is exclusive. Yesterday is usually final, today is an estimate. |
| `ce:GetCostForecast` | Forecast for the rest of the month. | $0.01 per request. |
| `ce:GetDimensionValues`, `ce:GetTags` | Valid service names and tag values. | Needed once to seed filters; service names are exact strings such as `EC2 - Other`. |
| `ce:GetAnomalies`, `ce:GetAnomalyMonitors` | Cost Anomaly Detection results. | Free service; one monitor per account is enough. |
| `ce:GetCostAndUsageWithResources` | Per-resource cost, last 14 days. | Needs opt-in per service; EC2-centric. Not needed here. |
| `budgets:DescribeBudgets` | Each budget's limit, actual and forecast. | Budgets API is `us-east-1` only; you already have a budget alarm from the deployment runbook. |
| `freetier:GetFreeTierUsage`, `GetAccountPlanState` | Remaining free-tier credit and offers. | Only useful while the account is inside a free plan. |
| Data Exports (CUR 2.0) + Athena | Line-item detail, tags per line. | Overkill for a two-service account; keep as the later option if per-resource questions appear. |

The Cost Explorer endpoint is global and is reached through `us-east-1` regardless of the task's `AWS_REGION`.

### Cost allocation tags

Every resource in the three stacks already carries `Application=fairsums`, `Environment=<stage|production>` and `Component=<web|admin>`. They do nothing for billing until activated once in the Billing console (Cost allocation tags → activate). Activation takes up to 24 hours and is not retroactive, so activate them now if a split by component or environment is wanted later. There is no per-tenant tag and cannot be: tenants are rows, not resources.

### What has to change

- **IAM** (`infra/service-admin.yaml`, task role): one new statement, resource `*` because Cost Explorer and Budgets have no resource-level permissions: `ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:GetDimensionValues`, `ce:GetTags`, `ce:GetAnomalies`, `ce:GetAnomalyMonitors`, `budgets:ViewBudget`, `budgets:DescribeBudgets`, optionally `freetier:GetFreeTierUsage`, `freetier:GetAccountPlanState`.
- **Account**: Cost Explorer must be enabled once in the console (first use takes up to 24 hours to backfill). Activate the three cost allocation tags. Create one Cost Anomaly Detection monitor (AWS services, account scope).
- **Packages**: `@aws-sdk/client-cost-explorer`, `@aws-sdk/client-budgets`, optional `@aws-sdk/client-freetier`. Credentials from the default chain, as the Cognito client already does; region pinned to `us-east-1` for these clients.
- **Job**: a new integration kind `aws_costs` in `src/lib/integrations` (key in `types.ts`, `jobs/aws-costs.ts`, `workFor()` case, seed row in a numbered SQL). Daily at 09:00 Toronto, after the previous day's data has settled. Four calls per run: daily by service for the last 35 days, month to date by component tag, forecast for the month, anomalies since the last run. About $1.20 a month at that cadence. "Run now" from the Integrations page costs $0.04.
- **Admin database** (numbered SQL, `prisma db pull --config prisma-admin.config.ts`): `admin_cost_daily (day, service, component, amount_usd, estimated, fetched_at)` and `admin_cost_snapshots (id, taken_at, month_to_date_usd, forecast_usd, budget_limit_usd, budget_actual_usd, anomalies json)`.
- **Endpoints**: `admin.costs.summary` (`GET /api/v1/admin/costs`) and `admin.costs.daily` (`GET /api/v1/admin/costs/daily?days=35`), both through `adminHandler`, registered in the endpoint registry and the access map SQL.
- **Page** `/costs` (`requirePageAccess("costs")`), rail entry in `shell/definitions.ts`: month-to-date and forecast figures, yesterday's total with the day-over-day change, a 35-day daily bar, cost by service (table), by component once tags are active, open anomalies, budget bar. Reads only the admin database; the page never calls AWS itself.
- **Overview** can show the same month-to-date and yesterday figures as cards; the page is a blank canvas today.

## 3. Cognito user statistics and churn

### What Cognito can tell you

| Source | Gives | Cost and limits |
| --- | --- | --- |
| `cognito-idp:ListUsers` (already permitted and used) | Per user: status (`CONFIRMED`, `FORCE_CHANGE_PASSWORD`, …), enabled flag, created and last-modified dates, attributes. | 60 pages of 200; no last-sign-in date exists on a user. |
| `cognito-idp:DescribeUserPool` | `EstimatedNumberOfUsers` and the pool's tier. | One call. |
| CloudWatch namespace `AWS/Cognito` | `SignInSuccesses`, `SignUpSuccesses`, `TokenRefreshSuccesses` and their `*Throttles`, `FederationSuccesses`; dimensions `UserPool` and `UserPoolClient`. `Sum` = successes per period, `SampleCount` = attempts. | Free at daily resolution; use `GetMetricData`, since metrics quiet for two weeks vanish from listings. Pool-level only, never per user. |
| Plus tier threat protection | `AdminListUserAuthEvents` per user (sign-ins with IP, device, risk), and export of every auth event to CloudWatch Logs, S3 or Firehose. | Plus is $0.020 per monthly active user with no free tier, against Essentials at $0.015 above 10,000 free users and Lite's 50,000 free for pools that predate November 2024. Audit-only mode is enough to get the logs. Not recommended at this stage; the app can record the same facts for free. |
| CloudTrail | Every user-pool API call, including `AdminDeleteUser`, `DeleteUser`, `AdminDisableUser`, `SignUp`, as management events. | Event history keeps 90 days and `LookupEvents` is free but limited to two requests per second. Longer retention needs a trail to S3, which is paid. |
| Lambda triggers | Pre sign-up, post confirmation, pre and post authentication, custom message, pre token generation, user migration, custom senders. | **There is no trigger for user deletion or disablement.** |
| Billing console, Cognito line | The month's monthly active users, which is what Cognito bills on. | Same number is reachable through Cost Explorer as usage quantity for the Cognito service. |

Two facts about today's code matter here. Nothing in either app deletes a confirmed user: the admin console's `AdminDeleteUser` is only used to revoke an unused invitation, and the web app has no "delete my account" flow. And the web app records nothing per request or per sign-in: `users` has no last-seen column, and the Customers page derives "last active" from the newest `updated_at` across a tenant's transactions, accounts, budgets and goals.

### Recommended design: an app-side ledger

- **Web app, main database** (owner-run SQL, then `prisma db pull`):
  - `users.last_seen_at timestamptz` — set by the session refresh route at most once per hour per user. Gives daily, weekly and monthly active users per tenant for free, and an estimate of Cognito's billable MAU.
  - `usage_daily (tenant_id, user_id, day, requests, errors, sync_rows, bytes_uploaded, primary key (tenant_id, user_id, day))` — upserted fire-and-forget from the web app's `apiHandler`, mirroring how the admin console's `recordEndpointUsage` works. RLS like every tenant table. This is also the input the cost-per-client model needs.
- **Admin console, admin database**:
  - `admin_customer_snapshots (sub, status, enabled, pool_created_at, pool_updated_at, seen_on)` written by a nightly `cognito_directory` integration job that pages `ListUsers` (already permitted).
  - `admin_customer_events (id, sub, event, at, source, details json)` with events `invited`, `confirmed`, `disabled`, `enabled`, `deleted`, `reappeared`. Written by two paths: the console's own actions (invite, revoke) synchronously, and the nightly diff of two snapshots, which catches deletions and disablements whoever performed them, including the AWS console. Optional third path: a `LookupEvents` sweep for `AdminDeleteUser` and `DeleteUser` in the last 24 hours to attach the actor.
  - `admin_pool_metrics_daily (day, sign_ins, sign_in_attempts, sign_ups, token_refreshes, throttles)` from one `GetMetricData` call per night.
- **Metrics the page can then show**: accounts by status; new accounts per day and per month; confirmations (invitation funnel: invited → confirmed → onboarded → first transaction, the last two from the main database); deletions and disablements per month; churn rate = accounts deleted or disabled in the month ÷ accounts active at the start of the month; retention by sign-up month; DAU, WAU, MAU; sign-ins per day from CloudWatch. When a self-service "delete my account" flow is built later, it writes the `deleted` event itself and the snapshot diff becomes the safety net.
- **IAM**: add `cognito-idp:DescribeUserPool` on the customer pool ARN and `cloudwatch:GetMetricData` on `*`. `cloudtrail:LookupEvents` on `*` only if the actor is wanted.
- **Where it lives**: an "Activity" view on the existing Customers page for the per-customer figures, a "Customer statistics" section or new page for the aggregates, and two Overview cards (active users this month, accounts added and removed this month).

## 4. Cost per client

### The limit

AWS bills per resource. The ECS tasks, the RDS instance, the load balancer, NAT, WAF, logs and Cognito are all shared by every tenant, so no AWS API can return a tenant's cost. The one exception is S3: attachments live under `tenants/<tenantId>/files/`, so storage per tenant is measurable, either by summing `file_blobs.byte_size` per tenant in the main database (free, exact for our own uploads) or through S3 Storage Lens prefix-level metrics (paid Advanced tier; not needed).

### The model that is honest and useful

Split the month's bill (from the Costs job, by service) into two pools and allocate each by a measured driver:

| Pool | Services | Driver per tenant | Source |
| --- | --- | --- | --- |
| Fixed capacity | ECS tasks, RDS instance hours, load balancer hours, NAT, WAF, Route 53, Secrets Manager, log ingestion baseline | Share of weighted activity: requests and sync rows from `usage_daily`, with a floor so a dormant tenant still carries a minimum share | `usage_daily` (new) |
| Storage | RDS allocated storage, S3 storage GB-month, backups | Bytes: `file_blobs.byte_size` per tenant plus an estimated row footprint from per-tenant row counts of the large tables (transactions, attachments, quotes) | main database (exists) |
| Per-request | S3 requests, load balancer LCU, data transfer, log volume | Requests and bytes uploaded from `usage_daily` | `usage_daily` (new) |
| Per-user | Cognito MAU | 1 if any user of the tenant has `last_seen_at` in the month | `users.last_seen_at` (new) |

Output: per tenant and month, an allocated cost in USD with the four components, the tenant's share of activity, storage bytes and active users. Label it "allocated estimate" on the page. Compute nightly in an `allocate_costs` job into `admin_tenant_cost_monthly (tenant_id, month, fixed_usd, storage_usd, request_usd, user_usd, total_usd, share_pct, computed_at)`; show as a "Cost" column and drawer on the Customers page, plus a ranked "most expensive tenants" list on Overview. Once pricing exists, margin per client is the same table joined with revenue.

Without step 1 (usage recording) the model can still run on storage bytes and row counts alone, splitting fixed cost equally between active tenants. That is a reasonable first version.

## 5. Other information worth having

- **Operations card** on Overview, all from `cloudwatch:GetMetricData` and free: RDS `FreeStorageSpace`, `DatabaseConnections` and `CPUUtilization` (the pool has `DATABASE_POOL_MAX=5` per task, so connection headroom matters); ECS `CPUUtilization` and `MemoryUtilization` per service; ALB `HTTPCode_Target_5XX_Count`, `TargetResponseTime`; WAF `BlockedRequests` for the admin host. Alarms on the same metrics would be the natural next step.
- **Budget and free-tier status** on the Costs page: the budget's actual versus limit and forecast; remaining free credit while the account has any.
- **Largest tenants by data**: bytes of attachments and row counts per tenant, from the main database, no AWS calls. Also flags who needs a retention or quota conversation.
- **Invitation funnel**: invited, confirmed, onboarded (tenant created), first transaction, first attachment, from Cognito status plus the main database. Shows where new users stall.
- **Service errors per tenant**: the `errors` column of `usage_daily` gives a support signal before the customer writes in.
- **Deploy health**: last deployment time and image tag per service from `ecs:DescribeServices`, if a "what is running" card is wanted. Needs `ecs:DescribeServices` on the two service ARNs.

## 6. Implementation summary

| Item | Repo | New IAM | New tables (numbered SQL) | Job | Endpoints and page | Size | Running cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Usage recording | web | none | `usage_daily`, `users.last_seen_at` (main DB) | none; written inline | none | S | none |
| Costs page | admin | `ce:*` read, `budgets:*` read, optional `freetier:*` | `admin_cost_daily`, `admin_cost_snapshots` | `aws_costs`, daily | `admin.costs.*`, `/costs`, rail icon | M | about $1.20 a month |
| Customer statistics | admin (+ small web change for events later) | `cognito-idp:DescribeUserPool`, `cloudwatch:GetMetricData`, optional `cloudtrail:LookupEvents` | `admin_customer_snapshots`, `admin_customer_events`, `admin_pool_metrics_daily` | `cognito_directory`, nightly | Customers page "Activity" view, statistics section, Overview cards | M | none |
| Cost per client | admin | none beyond the above | `admin_tenant_cost_monthly` | `allocate_costs`, nightly | Customers page column and drawer, Overview list | M | none |
| Operations card | admin | `cloudwatch:GetMetricData` | none, or reuse `admin_pool_metrics_daily` pattern | reuse nightly job or fetch on page load with a short cache | Overview | S | none |

Every job follows the existing integration pattern (key in `types.ts`, a `jobs/*.ts` work factory, a `workFor()` case, a seed row in `docs/sql`), so runs, "Run now" and history come for free on the Integrations page. Every page and endpoint follows the access-map pattern (page and endpoint registry entries plus a numbered SQL registering them; super-admin only until granted).

## 7. Decisions and prerequisites for the owner

1. Enable Cost Explorer in the AWS console and activate the `Application`, `Environment` and `Component` cost allocation tags. Both take up to a day and only affect data from then on.
2. Accept the Cost Explorer charge of $0.01 per request; at one run a day it is about $1.20 a month.
3. Stay on the Cognito Essentials tier. The Plus tier's per-user activity log is not worth $0.020 per active user when the app can record the same facts.
4. No CloudTrail trail for now; the nightly directory diff detects deletions without it. Revisit if "who deleted the account" matters.
5. Approve the two main-database additions (`usage_daily`, `users.last_seen_at`), since they touch the consumer schema and the Mac app should know about them.
6. Pick which pages to build, and in which order. The suggested order is section 1's.
