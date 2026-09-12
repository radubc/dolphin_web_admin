-- AWS costs: the daily Cost Explorer cache behind the Cost center page
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 012 (which registers the cost_center page row this file links to;
-- the two cost actions are created here, not there). Re-running is safe:
-- tables and indexes are created IF NOT EXISTS, every insert is guarded by
-- ON CONFLICT, and the one constraint that is replaced is dropped IF EXISTS
-- first, inside the same transaction.
--
-- Requires PostgreSQL 15 or newer for `UNIQUE NULLS NOT DISTINCT` (RDS runs
-- 16 or 17 here). Without it two rows for the same day and service could
-- exist, one with a component and one without, and the "by service" total
-- would double-count.
--
-- Why this file exists
--   The console had no idea what the account costs. AWS can tell it — Cost
--   Explorer answers "how much did each service cost on each day", Budgets
--   answers "how does that compare with the limit I set", Free Tier answers
--   "how much credit is left" — but every one of those is a signed AWS call,
--   Cost Explorer charges $0.01 per request, and the data only settles about
--   a day later. So the page must not call AWS: a daily job calls it once,
--   writes what it learned here, and the page reads these two tables.
--
--   * admin_cost_daily is the series the page draws: one row per day and
--     service (component NULL), which is what the daily bars and the "by
--     service" table are made of, plus — when the Component cost allocation
--     tag is active — one row per day and component for the month to date.
--     The last 35 days are re-fetched on every run, so a figure AWS revised
--     after the fact is corrected rather than frozen; `estimated` marks the
--     days AWS itself has not finalised (today, and yesterday until it
--     settles).
--
--   * admin_cost_snapshots is one row per run: the month-to-date total, the
--     forecast for the rest of the month, the budget's limit / actual /
--     forecast, the free-tier state and the open anomalies. A snapshot per
--     run rather than an updated single row, so "what did we think the
--     month would cost on the 3rd" is still answerable on the 30th. The page
--     reads the newest one.
--
--   Nothing here is per tenant, and nothing can be: AWS bills per resource
--   and every resource except an S3 object is shared by all tenants. Cost
--   per client is an allocation computed from recorded usage (a later file);
--   the Cost center page shows that section as empty until then.
--
-- What this adds
--   admin_cost_daily          cost per day and service (and per component)
--   admin_cost_snapshots      one row per job run: totals, budget, free tier,
--                             anomalies
--   admin_integrations        one row: the `aws_costs` integration, daily at
--                             09:00 America/Toronto
--   admin_integrations_provider_chk is replaced so provider may also be 'aws'
--   admin_actions             two rows: can_read_costs, can_write_costs.
--                             THIS file seeds them; 012 registers the three
--                             new pages and creates no actions at all
--   admin_page_actions        links the `cost_center` page (012's row) to
--                             those two actions
--   admin_endpoints           the two Cost center endpoints, mirroring
--                             src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions    both endpoints (reads) take can_read_costs or
--                             can_write_costs, named explicitly so neither
--                             endpoint can end up with no actions at all
--
-- Nothing is changed or removed. The five existing integrations, their runs
-- and their caches are untouched; `aws_costs` is a sixth row in the same
-- table and appears on the Integrations page like the others.
--
-- Before the job can succeed (both are account settings, not SQL):
--   1. Open Cost Explorer once in the AWS console. Until then every
--      ce:* call answers DataUnavailableException and the run fails with a
--      message saying exactly this. First use takes up to 24 hours to
--      backfill.
--   2. Activate the `Application`, `Environment` and `Component` cost
--      allocation tags (Billing -> Cost allocation tags). Activation takes
--      up to 24 hours and is NOT retroactive, so the "By component" table
--      stays empty for spend incurred before it. The job tolerates the tag
--      being inactive; it simply writes no component rows.
--   See docs/costs.md.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_cost_daily
-- One row per day and service, in USD. `component` is NULL for the by-service
-- series and carries the value of the `Component` cost allocation tag for the
-- by-component series; the unique key is NULLS NOT DISTINCT so the NULL rows
-- cannot be duplicated.
--
-- NUMERIC(14,6) — six decimals because AWS itself bills to six: a day of one
-- small service really is $0.0043, and a per-request line can be $0.000004.
-- Four decimals rounded those to zero, which then disappeared from the table
-- altogether (the job drops rows that come to 0), so a service that costs a
-- few cents a month looked free. Eight digits of headroom before the point is
-- more account than this product will ever be.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_cost_daily (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The calendar day the cost was incurred, in UTC, as Cost Explorer reports
  -- it. A DATE: no time, no zone.
  day        DATE NOT NULL,
  -- Cost Explorer's own SERVICE dimension value, verbatim: 'Amazon Relational
  -- Database Service', 'EC2 - Other'. Not normalised — the exact string is
  -- what a later filter has to send back.
  service    TEXT NOT NULL,
  -- The `Component` cost allocation tag ('web', 'admin'), or NULL for the
  -- by-service series. '' is what AWS returns for resources the tag does not
  -- cover; the job stores that as the literal empty string, not NULL, so
  -- "untagged" and "not split by component" stay different facts.
  component  TEXT,
  amount_usd NUMERIC(14, 6) NOT NULL DEFAULT 0,
  -- TRUE while AWS still calls the figure an estimate (today, and yesterday
  -- until it settles). An estimated row is expected to change on the next run.
  estimated  BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_cost_daily_day_service_component_key
    UNIQUE NULLS NOT DISTINCT (day, service, component)
);

CREATE INDEX IF NOT EXISTS idx_admin_cost_daily_day
  ON admin_cost_daily (day DESC);
CREATE INDEX IF NOT EXISTS idx_admin_cost_daily_service_day
  ON admin_cost_daily (service, day DESC);
CREATE INDEX IF NOT EXISTS idx_admin_cost_daily_component_day
  ON admin_cost_daily (component, day DESC);

COMMENT ON TABLE admin_cost_daily IS
  'Cached AWS cost per day and service in USD, written by the aws_costs integration from ce:GetCostAndUsage. component IS NULL is the by-service series the page draws; a non-NULL component is the month-to-date split by the Component cost allocation tag. The last 35 days are re-fetched every run, so revised figures are corrected.';
COMMENT ON COLUMN admin_cost_daily.component IS
  'The Component cost allocation tag value, or NULL for the by-service series. AWS returns '''' for resources the tag does not cover.';
COMMENT ON COLUMN admin_cost_daily.estimated IS
  'TRUE while AWS still calls the figure an estimate. Such a row is expected to change on the next run.';

-- ---------------------------------------------------------------------------
-- admin_cost_snapshots
-- One row per run of the aws_costs job: everything that is a single figure
-- rather than a series. The page reads the newest row; the history is kept so
-- a forecast can be compared with what the month actually cost.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_cost_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taken_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The month the figures describe, 'YYYY-MM' in UTC. TEXT rather than a DATE
  -- because it is a label the page prints, never arithmetic.
  month               TEXT NOT NULL,
  -- Spend so far this month, from the daily series the same run wrote. Four
  -- decimals here, not six: this is a sum of many rows, and a hundredth of a
  -- cent on a month's total is noise where it mattered on a single row.
  month_to_date_usd   NUMERIC(12, 4) NOT NULL DEFAULT 0,
  -- ce:GetCostForecast for [today .. 1st of next month), added to the month
  -- to date, so the two together are the whole month exactly once. That API
  -- requires a Start no later than today, which is why the window starts
  -- today and not tomorrow. NULL when Cost Explorer says it has too little
  -- history to forecast (a new account), or when the call failed.
  forecast_usd        NUMERIC(12, 4),
  -- The budget the figures below belong to (settings.budgetName, else the
  -- first budget the account has). NULL when the account has no budget.
  budget_name         TEXT,
  budget_limit_usd    NUMERIC(12, 4),
  budget_actual_usd   NUMERIC(12, 4),
  budget_forecast_usd NUMERIC(12, 4),
  -- freetier:GetAccountPlanState + GetFreeTierUsage, as
  -- { planType, planStatus, offers: [{ service, description, unit, used,
  -- limit, forecasted, actual }] }. NULL when the account is not on a free
  -- plan or the API refused (both normal: "not applicable").
  free_tier           JSONB,
  -- ce:GetAnomalies for the last 35 days, as an array of
  -- { id, service, startDate, endDate, totalImpactUsd, maxImpactUsd,
  --   totalActualUsd, totalExpectedUsd, feedback }. '[]' when there are none,
  -- which is the good case, and also what an account with no anomaly monitor
  -- looks like.
  anomalies           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- What each AWS call answered about, for support: which calls were made,
  -- which failed and why, how many CE requests the run spent. Never a
  -- credential and never a full API response.
  raw                 JSONB,

  CONSTRAINT admin_cost_snapshots_month_chk CHECK (month ~ '^[0-9]{4}-[0-9]{2}$')
);

CREATE INDEX IF NOT EXISTS idx_admin_cost_snapshots_taken_at
  ON admin_cost_snapshots (taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_cost_snapshots_month_taken_at
  ON admin_cost_snapshots (month, taken_at DESC);

COMMENT ON TABLE admin_cost_snapshots IS
  'One row per aws_costs run: month-to-date total, forecast, budget limit/actual/forecast, free-tier state and open anomalies. The Cost center page reads the newest row; older rows keep the forecasts a month was given while it ran.';
COMMENT ON COLUMN admin_cost_snapshots.raw IS
  'Which AWS calls the run made, which failed and why, and how many Cost Explorer requests it spent. Never a credential, never a full API response.';

-- ---------------------------------------------------------------------------
-- admin_integrations.provider gains 'aws'
-- The set mirrors INTEGRATION_PROVIDERS in src/lib/integrations/types.ts.
-- Dropping first keeps the file re-runnable; the constraint is recreated in
-- the same transaction, so the column is never left unguarded.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_integrations DROP CONSTRAINT IF EXISTS admin_integrations_provider_chk;
ALTER TABLE admin_integrations ADD CONSTRAINT admin_integrations_provider_chk
  CHECK (provider IN ('twelvedata', 'bank_of_canada', 'iso20022', 'alpha_vantage', 'aws'));

-- ---------------------------------------------------------------------------
-- Seed: the aws_costs integration
--
-- 09:00 America/Toronto, not the small hours the market-data jobs use:
-- Cost Explorer settles the previous day some hours into it, so an 01:00 run
-- would read a figure it then has to correct. requires_api_key is FALSE and
-- api_key_env is NULL — the credential is the task role, resolved by the AWS
-- SDK's default chain, and no environment variable holds it.
--
-- base_url is the Cost Explorer endpoint. It is the column the Integrations
-- page shows as "where this goes" and is deliberately the global us-east-1
-- host (Cost Explorer, Budgets and Free Tier are all reached there whatever
-- the task's AWS_REGION is). The SDK builds its own endpoint; nothing reads
-- this value, and editing it changes nothing — see src/lib/costs/aws.ts.
--
-- settings.days is how many days back the daily fetch covers (35, so a month
-- of bars is always complete and a revised figure is still in range; the app
-- clamps it to 120, because every page of the answer is a charged request);
-- settings.componentTag names the cost allocation tag the month split is
-- grouped by. settings.budgetName may be added by an operator to pin one
-- budget when the account has several. All four are editable on the
-- Integrations page.
--
-- What a run spends: THREE charged Cost Explorer requests — the daily series
-- by service, this month by service and component, and the forecast — at
-- $0.01 each, plus one more on the first three days of a month, when the
-- previous month's component split is re-read once its last day has settled.
-- So about $0.03 a day and roughly $1 a month at one run a day. GetAnomalies,
-- Budgets, Free Tier and sts:GetCallerIdentity are free.
-- ---------------------------------------------------------------------------
INSERT INTO admin_integrations
  (key, name, description, provider, base_url, requires_api_key, api_key_env,
   schedule_frequency, schedule_hour, schedule_minute, settings) VALUES
  ('aws_costs', 'AWS costs', 'Daily AWS spend from Cost Explorer, plus the budget, the free-tier state and open cost anomalies, cached for the Cost center page. Each run spends 3 charged Cost Explorer requests at $0.01 each, and a 4th on the first three days of a month — about $1 a month.', 'aws', 'https://ce.us-east-1.amazonaws.com', FALSE, NULL, 'daily', 9, 0, '{"days": 35, "componentTag": "Component"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: the two actions
--
-- This file is where the two cost actions come from. 012 registers the three
-- new rail pages (`cost_center`, `sales_billing`, `marketing`) and
-- deliberately creates no actions: all three ship require_super_admin = TRUE
-- with nothing linked. ON CONFLICT keeps the inserts re-runnable, and it also
-- means an earlier file that happened to seed the same keys is not disturbed.
-- ---------------------------------------------------------------------------
INSERT INTO admin_actions (key, description, category) VALUES
  ('can_read_costs',  'View the Cost center: AWS spend, budget, free tier and anomalies',                      'costs'),
  ('can_write_costs', 'Reserved for future Cost center writes; a refresh needs can_write_integrations instead', 'costs')
ON CONFLICT (key) DO NOTHING;

-- The page -> action links. A no-op when the page row does not exist yet
-- (the SELECT finds nothing), so running this before 012 is harmless — but
-- then the links have to be made by running this file again afterwards.
--
-- Both spellings of the page key are matched because 002's
-- admin_pages_key_format_chk is `^[a-z][a-z0-9_]*$` — a hyphen is NOT allowed,
-- so the row for the /cost-center route has to be keyed `cost_center` even
-- though the path has a hyphen. Matching both costs nothing and means this
-- file is right either way.
--
-- This loosens nothing: 012 seeds the page with require_super_admin = TRUE,
-- which outranks any action link, so the page stays super-admin only until
-- the owner clears that flag on the Access Map. The links are what make the
-- two endpoints below grantable at all.
--
-- Note what actually governs the page's "Refresh now" button: it starts the
-- aws_costs run through POST /api/v1/admin/integrations/[key]/run, so the
-- rule that decides it is that endpoint's — can_write_integrations — not
-- can_write_costs. The cost actions gate the page and its two read
-- endpoints. Grant can_write_integrations to whoever should be able to spend
-- three cents on a refresh.
INSERT INTO admin_page_actions (page_id, action_id)
SELECT p.id, a.id FROM admin_pages p CROSS JOIN admin_actions a
WHERE p.key IN ('cost_center', 'cost-center')
  AND a.key IN ('can_read_costs', 'can_write_costs')
ON CONFLICT (page_id, action_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: endpoints (keys, methods and paths must match
-- src/lib/admin-access/endpoint-registry.ts)
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.costs.summary', 'GET', '/api/v1/admin/costs',       'Cost summary',     'The newest cost snapshot with month-to-date and previous-30-day totals per service and per component, and when the aws_costs job last ran. Reads the admin database only; never calls AWS.', 'costs', 'admin', 'api', FALSE),
  ('admin.costs.daily',   'GET', '/api/v1/admin/costs/daily', 'Daily cost series', 'One entry per day for the last ?days (1..400, default 35): the day''s total, whether AWS still calls it an estimate, and the amount per service. Reads the admin database only.',      'costs', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Endpoint -> actions (ANY-OF). Both endpoints are reads on the Cost center,
-- so each takes the two cost actions this file seeds above, which are also
-- what src/lib/admin-access/endpoint-registry.ts lists as their defaults:
-- can_read_costs or can_write_costs.
--
-- The action keys are named here rather than derived from admin_page_actions.
-- Deriving reads better — "whoever may open the page may read the figures on
-- it" — but it silently depends on the page row and its links existing: if
-- that SELECT finds nothing, nothing is inserted, the endpoints end up with
-- **zero** actions, and evaluateRule() treats an endpoint with no actions and
-- require_super_admin = FALSE as reachable by any admin. Naming the keys
-- cannot fail that way; the two actions are inserted a few statements above,
-- in this same transaction. require_super_admin stays FALSE only because
-- these rows are present.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE e.key IN ('admin.costs.summary', 'admin.costs.daily')
  AND a.key IN ('can_read_costs', 'can_write_costs')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
