-- Cost per client: the monthly allocation of the AWS bill over per-tenant
-- measured usage, behind the Cost center's "Cost per client" card and the
-- Customers page's "Cost (est.)" column
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 014. Re-running is safe: the table and its indexes are created
-- IF NOT EXISTS and every insert is guarded by ON CONFLICT.
--
-- Why this file exists
--   "What does this customer cost us" has no answer at AWS. AWS bills per
--   *resource*, and every resource this product runs on — the two ECS
--   services, the RDS instance, the load balancer, NAT, WAF, Route 53,
--   Secrets Manager, the log groups — is shared by every tenant. There is no
--   per-tenant tag and there cannot be one: tenants are rows, not resources.
--   The single exception is S3, where attachments live under
--   tenants/<tenantId>/files/, and even that is cheaper to measure by summing
--   file_blobs.byte_size in the main database than by paying for S3 Storage
--   Lens.
--
--   So the honest answer is an **allocation**: take the month's bill, which
--   013's aws_costs job already caches per day and service, split it into
--   four pools by what drives each service's cost, and divide each pool over
--   the tenants by a driver that is actually measured (requests and sync rows
--   from the consumer app's usage_daily, attachment bytes and row counts,
--   active users from users.last_seen_at). The result is an estimate, is
--   labelled as an estimate everywhere it is shown, and is stored here once a
--   night rather than computed on a page load — the arithmetic reads four
--   aggregates of the main app database and would be wasteful per request.
--
--   Section 4 of docs/cost-usage-and-customer-stats-plan.md is the research;
--   docs/cost-allocation.md is the model as built, including the pools map,
--   the floor and the two estimated constants.
--
-- What this adds
--   admin_tenant_cost_monthly   one row per tenant and month: the four pool
--                               components, the total, the tenant's share of
--                               the month, and the drivers the split was made
--                               from
--   admin_integrations          one row: the `allocate_costs` integration,
--                               daily at 03:30 America/Toronto
--   admin_endpoints             one row: admin.costs.per_client, mirroring
--                               src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions      the endpoint (a read) takes can_read_costs or
--                               can_write_costs, named explicitly so it
--                               cannot end up with no actions at all
--
-- Nothing is changed and nothing is removed. The seven existing integrations,
-- their runs and their caches are untouched; `allocate_costs` is an eighth row
-- in the same table and appears on the Integrations page like the others.
-- admin_integrations_provider_chk is NOT touched: 013 widened it to allow
-- 'aws', which is the provider this row uses.
--
-- A note on that provider value. This run makes **no AWS call at all** — it
-- reads admin_cost_daily (this database) and the consumer app's usage tables
-- (the main database) and writes here — so 'internal' would describe it
-- better. 'internal' is not one of the values
-- admin_integrations_provider_chk allows, and widening that CHECK would mean
-- widening INTEGRATION_PROVIDERS in src/lib/integrations/types.ts and the
-- base-URL domain map beside it, for a row whose base_url nothing reads. So
-- the row is recorded as provider 'aws' — the data it divides up is AWS's —
-- and the description says it costs nothing to run. See docs/cost-allocation.md.
--
-- Before the numbers mean anything
--   1. 013 must have run and the `aws_costs` job must have succeeded at least
--      once for the month being allocated: with no rows in admin_cost_daily
--      there is no bill to divide, and the run says exactly that and fails.
--   2. The consumer app must be recording usage_daily and users.last_seen_at.
--      Without them the activity and per-user drivers are all zero, the fixed
--      pool is split equally (its floor plus an equal share of the
--      remainder), and the storage pool still splits by attachment bytes — a
--      thin but not wrong first version.
--   No IAM change, no account setting, no cost: everything this run needs is
--   already in the two databases.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_tenant_cost_monthly
-- One row per tenant and month: the allocated estimate, its four components,
-- and the drivers it was computed from.
--
-- The drivers are stored beside the money on purpose. A figure like "$4.12"
-- is unarguable and useless; "$4.12, of which $3.60 is the shared capacity
-- your 12 400 requests bought you, over 48 MB of attachments and 2 active
-- users" is something an operator can check, explain to a customer, and
-- notice is wrong. They also make the row reproducible: the same drivers and
-- the same month's bill always give the same answer.
--
-- NUMERIC(14,6) — six decimals because the allocation is computed in
-- micro-dollars (see below) and a tenant's share of a $30 month really is
-- $0.014212; eight digits before the point, which is more account than this
-- product will ever be.
--
-- Why micro-dollars. Each pool is divided with a largest-remainder pass over
-- integer micro-dollars, so the tenants' components sum to the pool *exactly*
-- rather than to the pool plus or minus a rounding step. A per-client table
-- whose column does not add up to the bill invites exactly the wrong
-- conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_tenant_cost_monthly (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- tenants.id in the **main app database**. TEXT and not a foreign key:
  -- this database cannot reference that one, and the row has to outlive the
  -- tenant so a month that has been paid for stays answerable.
  tenant_id       TEXT        NOT NULL,
  -- The month the figures describe, 'YYYY-MM' in UTC. TEXT rather than a
  -- DATE because it is a label the page prints and a key rows are grouped
  -- by, never arithmetic. Same convention as admin_cost_snapshots.month.
  month           TEXT        NOT NULL,
  -- The four pool components, in USD.
  --   fixed   — shared capacity (ECS, RDS, the load balancer, NAT, WAF,
  --             Route 53, Secrets Manager, CloudWatch, and anything the pools
  --             map does not recognise), split by activity weight with a
  --             floor first for every tenant that was still live at the end
  --             of the month. The floors together are capped at half the
  --             pool, so at least half of the shared capacity is always
  --             divided by measurement, however many tenants there are;
  --   storage — S3, split by attachment bytes plus an estimated row
  --             footprint;
  --   request — data-transfer style services, split by requests. Usually
  --             zero: the account has no such line today;
  --   user    — Cognito, split by the tenant's active users in the month. A
  --             tenant nobody signed in to gets 0.
  fixed_usd       NUMERIC(14, 6) NOT NULL DEFAULT 0,
  storage_usd     NUMERIC(14, 6) NOT NULL DEFAULT 0,
  request_usd     NUMERIC(14, 6) NOT NULL DEFAULT 0,
  user_usd        NUMERIC(14, 6) NOT NULL DEFAULT 0,
  -- The sum of the four. Stored rather than derived so "order by cost" is one
  -- index scan and the ranked lists cost nothing.
  total_usd       NUMERIC(14, 6) NOT NULL DEFAULT 0,
  -- total_usd as a percentage of the whole month's bill, four decimals. A
  -- percentage and not a fraction, because that is what every reader of the
  -- column wants and NUMERIC(7,4) holds it exactly.
  --
  -- Normally 0..100, but not guaranteed to be: a bill revised downwards after
  -- the allocation was written can put a tenant above 100, and a month where
  -- one pool is a credit and another is spend can put a share below zero. The
  -- writer clamps to +/-999.9999 (three digits before the point is all this
  -- type holds) so such a month cannot fail to write with a numeric overflow
  -- and lose its rows.
  share_pct       NUMERIC(7, 4)  NOT NULL DEFAULT 0,
  -- The driver behind fixed_usd: requests + sync_rows from usage_daily for
  -- the month. Kept as NUMERIC rather than an integer because it is a weight,
  -- and a weighting scheme that is not a plain sum (a cost per sync row
  -- different from a cost per request, say) should not need a column change.
  activity_weight NUMERIC(14, 4) NOT NULL DEFAULT 0,
  -- The driver behind storage_usd: live file_blobs bytes plus the estimated
  -- row footprint. A *current* measurement, not a historical one — see
  -- docs/cost-allocation.md.
  storage_bytes   BIGINT      NOT NULL DEFAULT 0,
  -- The driver behind request_usd, and half of the activity weight.
  requests        INTEGER     NOT NULL DEFAULT 0,
  -- The driver behind user_usd: distinct users of the tenant who were seen,
  -- or recorded any usage, inside the month.
  active_users    INTEGER     NOT NULL DEFAULT 0,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_tenant_cost_monthly_month_chk
    CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- One allocation per tenant per month. The nightly run upserts on this key,
  -- so re-running a month replaces its own answer rather than adding a second.
  CONSTRAINT admin_tenant_cost_monthly_tenant_month_key UNIQUE (tenant_id, month)
);

-- "The most expensive tenants this month", which is how both the rail card
-- and the Overview list read the table.
CREATE INDEX IF NOT EXISTS idx_admin_tenant_cost_monthly_month_total
  ON admin_tenant_cost_monthly (month, total_usd DESC);
-- "This tenant over the last few months", which is how the Customers drawer
-- reads it.
CREATE INDEX IF NOT EXISTS idx_admin_tenant_cost_monthly_tenant_month
  ON admin_tenant_cost_monthly (tenant_id, month DESC);

COMMENT ON TABLE admin_tenant_cost_monthly IS
  'Allocated estimate of the AWS bill per tenant and month, written by the allocate_costs integration: the month''s cost from admin_cost_daily split into four pools (fixed capacity, storage, per-request, per-user) and divided over the tenants by measured drivers from the main app database (usage_daily, file_blobs, transactions, users.last_seen_at). An estimate, never a bill: AWS bills per resource and every resource except an S3 object is shared by all tenants. Mirrors docs/sql/015_cost_allocation.sql; the model is docs/cost-allocation.md.';
COMMENT ON COLUMN admin_tenant_cost_monthly.tenant_id IS
  'tenants.id in the main app database. Not a foreign key: different database, and the row must outlive the tenant.';
COMMENT ON COLUMN admin_tenant_cost_monthly.fixed_usd IS
  'Share of the shared-capacity pool: every tenant still live at the end of the month gets settings.fixedFloorShare of it first (the floors together capped at half the pool), and the remainder is split over every tenant by activity_weight. A tenant with no activity at all still carries the floor, because the capacity was there for them; a tenant deleted during the month carries no floor but keeps whatever its measured drivers earned it.';
COMMENT ON COLUMN admin_tenant_cost_monthly.share_pct IS
  'total_usd as a percentage of the whole month''s bill, normally 0..100 and clamped to +/-999.9999. Pools whose driver was zero for every tenant are left unallocated, so the shares need not sum to 100; a bill revised downwards after the allocation was written can put a share above 100, and a month mixing a credit with spend can put one below zero.';
COMMENT ON COLUMN admin_tenant_cost_monthly.storage_bytes IS
  'Live file_blobs.byte_size for the tenant plus 512 bytes per live transaction row, as a stand-in for the database footprint. Measured when the run happens, not as it was during the month.';

-- ---------------------------------------------------------------------------
-- Seed: the allocate_costs integration
--
-- 03:30 America/Toronto, after both jobs it depends on: aws_costs runs at
-- 09:00 (so the figures it reads are yesterday morning's, which is as fresh
-- as Cost Explorer gets) and cognito_directory at 02:30. An hour after the
-- directory run rather than a minute, so a slow pool listing cannot push the
-- two into each other.
--
-- provider 'aws' with requires_api_key FALSE and api_key_env NULL — see the
-- note at the top of this file: the run makes no AWS call and needs no
-- credential of any kind. base_url is the Cost Explorer host, which is where
-- the money figures this run divides up came from; nothing reads it and
-- editing it changes nothing.
--
-- settings.months is how many months each run recomputes, ending with the
-- current (partial) month. 2 by default: the current month, whose figures
-- move every day, and the one before it, which Cost Explorer may still
-- revise. settings.fixedFloorShare is the share of the shared-capacity pool
-- every tenant still live at the end of the month is given before the rest is
-- split by activity — 0.005, half a percent, so twenty dormant tenants carry
-- a tenth of the capacity between them. The code caps the floors at half the
-- pool between them (0.5 / eligible tenants), so the floor can never crowd
-- out the measurement however many tenants there are.
-- ---------------------------------------------------------------------------
INSERT INTO admin_integrations
  (key, name, description, provider, base_url, requires_api_key, api_key_env,
   schedule_frequency, schedule_hour, schedule_minute, settings) VALUES
  ('allocate_costs', 'Cost allocation', 'Nightly allocation of the month''s AWS bill over the tenants, from the cached cost rows and the consumer app''s recorded usage: four pools (shared capacity, storage, per-request, per-user) divided by measured drivers into admin_tenant_cost_monthly. Makes no AWS call and costs nothing; it needs the aws_costs run to have cached the month first.', 'aws', 'https://ce.us-east-1.amazonaws.com', FALSE, NULL, 'daily', 3, 30, '{"months": 2, "fixedFloorShare": 0.005}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: the endpoint (key, method and path must match
-- src/lib/admin-access/endpoint-registry.ts)
--
-- `per-client` is a static segment under /api/v1/admin/costs, like `daily`.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.costs.per_client', 'GET', '/api/v1/admin/costs/per-client', 'Cost per client', 'The allocated cost estimate per tenant for one month (?month=YYYY-MM, default the current month): the four pool totals, each tenant''s four components with the drivers behind them, its share of the month, and what is left unallocated. Reads admin_tenant_cost_monthly and the main app database''s tenant names; never calls AWS and never recomputes.', 'costs', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Endpoint -> actions (ANY-OF). A read on the Cost center page, so it takes
-- the same two actions 013 seeded and linked to that page, which are also
-- what src/lib/admin-access/endpoint-registry.ts lists as this endpoint's
-- defaults: can_read_costs or can_write_costs.
--
-- Named explicitly rather than derived from admin_page_actions, for the
-- reason 013 now gives: a derived insert is a no-op when the page row or its
-- links are missing, which would leave the endpoint with **zero** actions —
-- and evaluateRule() treats an endpoint with no actions and
-- require_super_admin = FALSE as reachable by any admin. The two actions come
-- from 013, which the header already requires to have run.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE e.key = 'admin.costs.per_client'
  AND a.key IN ('can_read_costs', 'can_write_costs')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
