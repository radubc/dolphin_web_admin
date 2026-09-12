-- Customer statistics: the nightly Cognito directory snapshot, the lifecycle
-- event log and the pool-level CloudWatch metrics behind the Customers page's
-- Activity view
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 013 (the AWS costs cache, which is what first allowed
-- admin_integrations.provider = 'aws'). Re-running is safe: tables and indexes
-- are created IF NOT EXISTS and every insert is guarded by ON CONFLICT.
--
-- Why this file exists
--   The console could say who the customers are, but nothing about how the
--   population moves: how many accounts appeared last month, how many went
--   away, who is still coming back, where a new person stalls. None of that
--   is answerable from a live query, because the two systems that hold the
--   facts do not keep the history:
--
--     * Cognito has no per-user activity on the Essentials tier, no event for
--       a deletion and no trigger for one either. ListUsers tells you who is
--       in the pool *right now*; an account that was deleted yesterday simply
--       is not there, and nothing says it ever was.
--     * The main app database now stamps users.last_seen_at and counts
--       per-user requests in usage_daily, which answers "who is active", and
--       it soft-deletes with users.deleted_at / tenants.deleted_at, which
--       answers "who left through the app". It cannot answer what happened in
--       the pool to someone who never signed in.
--
--   So the admin app keeps its own history. Once a night the
--   `cognito_directory` integration writes today's directory to
--   admin_customer_snapshots, diffs it against the previous snapshot day, and
--   records what changed as rows in admin_customer_events. Deletions,
--   disablements and confirmations are therefore visible whoever performed
--   them — an operator here, the AWS console, or the person themselves — and
--   they stay visible after the account is gone. Pool-wide sign-in and
--   sign-up counts come from CloudWatch in the same run and land in
--   admin_pool_metrics_daily.
--
--   Two paths write events, exactly as the invitations table has two writers:
--   the console's own actions write synchronously (an invite is `invited`, a
--   revoked invitation is `deleted`), and the nightly diff is the safety net
--   that catches everything else. Self-service deletions in the consumer app
--   are picked up from the main database's users.deleted_at as
--   `deleted_in_app` the same night.
--
-- What this adds
--   admin_customer_snapshots   one row per pool account per day it was seen,
--                              with `partial` marking a day whose listing was
--                              cut short
--   admin_customer_events      the lifecycle log: invited, confirmed,
--                              disabled, enabled, deleted, reappeared,
--                              deleted_in_app
--   admin_pool_metrics_daily   AWS/Cognito CloudWatch counters per UTC day
--   admin_integrations         one row: the `cognito_directory` integration,
--                              daily at 02:30 America/Toronto
--   admin_endpoints            two rows: the statistics and per-customer
--                              activity endpoints, mirroring
--                              src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions     both endpoints (reads) take can_read_user_list,
--                              can_read_user_detail or can_invite_users --
--                              the same ANY-OF set 010 gave the Customers
--                              reads, named explicitly so neither endpoint
--                              can end up with no actions at all
--
-- Nothing is changed and nothing is removed. admin_customer_invites, the
-- Customers endpoints and the six existing integrations are untouched;
-- `cognito_directory` is a seventh integration row and appears on the
-- Integrations page like the others. admin_integrations_provider_chk is NOT
-- touched: 013 already widened it to allow 'aws', which is the provider this
-- row uses. If for some reason 013 has not been run, run it first — this
-- file's INSERT would otherwise be refused by that CHECK.
--
-- Before the job can succeed (both are IAM, not SQL; infra/service-admin.yaml
-- already carries them):
--   1. cognito-idp:ListUsers and cognito-idp:DescribeUserPool on the customer
--      pool ARN. ListUsers is already used by the Customers list.
--   2. cloudwatch:GetMetricData on "*" (CloudWatch
--      has no resource-level permissions for these). Without them the
--      snapshot and the diff still work; only the pool metrics are skipped.
--   CUSTOMER_COGNITO_USER_POOL_ID must be set, as it is for the Customers
--   page. See docs/customers.md.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_customer_snapshots
-- One row per pool account per day the nightly job saw it. The primary key is
-- (sub, seen_on), so a run that is repeated on the same day overwrites its own
-- rows rather than adding a second reading.
--
-- This is a *history table*, not a cache: rows are never deleted, because the
-- absence of a sub on a later day is precisely what a deletion looks like.
-- At a few thousand accounts it grows by a few thousand narrow rows a night,
-- which is small; a retention policy (keep the first snapshot of each month
-- past a year, say) is a later file and a decision, not an emergency.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_customer_snapshots (
  -- The Cognito `sub` attribute, which is also what the main app database's
  -- users.cognito_sub holds. TEXT, not UUID: it is an opaque identifier from
  -- another system and must round-trip whatever Cognito sends.
  sub             TEXT        NOT NULL,
  -- The UTC day the snapshot was taken. A DATE: the job runs once a night and
  -- "which day did we see this" is the only granularity anything needs.
  seen_on         DATE        NOT NULL,
  -- Cognito's UserStatus, normalised to lower case by the job:
  -- confirmed | force_change_password | unconfirmed | reset_required |
  -- unknown. Not a CHECK: Cognito may add a status, and a snapshot that
  -- refused to record a new one would lose the account from the history
  -- entirely, which is worse than an unfamiliar string.
  status          TEXT        NOT NULL,
  -- The pool's Enabled flag. FALSE is an account an operator (or Cognito)
  -- switched off; the person cannot sign in.
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  -- UserCreateDate / UserLastModifiedDate as the pool reports them. Kept so
  -- "new accounts per month" can be answered from the pool's own dates rather
  -- than from when this job first noticed the account.
  pool_created_at TIMESTAMPTZ,
  pool_updated_at TIMESTAMPTZ,
  -- The email attribute, for a lifecycle row whose account is gone from both
  -- the pool and the app database and would otherwise be an anonymous sub.
  -- Nullable: the attribute is not guaranteed to be readable, and an older
  -- snapshot may predate this column being filled.
  email           TEXT,
  -- TRUE when the ListUsers paging that produced this day was cut short by
  -- the app's page cap (LIST_PAGE_CAP in src/lib/customers/cognito.ts), so
  -- the day is missing accounts that do exist. The rows are still written --
  -- partial data is still data, and the accounts the listing did reach are
  -- real -- but the day must never become the *previous* side of a diff:
  -- every account the listing never reached would be recorded as deleted the
  -- following night. previousSnapshotDay() in src/lib/customers/lifecycle.ts
  -- therefore skips these days and reaches further back, which is exactly
  -- what it already does for a night the job did not run. Every row of one
  -- day carries the same value; the flag describes the day, and a column is
  -- where it can live. The (seen_on DESC) index below serves that lookup:
  -- the filter is one boolean on rows already in order.
  partial         BOOLEAN     NOT NULL DEFAULT FALSE,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_customer_snapshots_pkey PRIMARY KEY (sub, seen_on)
);

-- For a database where an earlier version of this file already created the
-- table: CREATE TABLE IF NOT EXISTS above would have skipped it and left the
-- column missing. Idempotent, and a no-op on a fresh run.
ALTER TABLE admin_customer_snapshots
  ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT FALSE;

-- The diff reads "the whole of the most recent previous day", and the page
-- reads "the newest day"; both are a range scan on seen_on.
CREATE INDEX IF NOT EXISTS idx_admin_customer_snapshots_seen_on
  ON admin_customer_snapshots (seen_on DESC);
-- The funnel counts accounts by status within one day.
CREATE INDEX IF NOT EXISTS idx_admin_customer_snapshots_seen_on_status
  ON admin_customer_snapshots (seen_on DESC, status);

COMMENT ON TABLE admin_customer_snapshots IS
  'One row per customer-pool account per day the cognito_directory job saw it (cognito-idp:ListUsers). A history table, never pruned by the job: a sub that is present on one day and absent the next is how a deletion is detected, since Cognito has no deletion event or trigger. Mirrors docs/sql/014_customer_statistics.sql.';
COMMENT ON COLUMN admin_customer_snapshots.status IS
  'Cognito UserStatus, lower-cased: confirmed | force_change_password | unconfirmed | reset_required | unknown. Deliberately not constrained, so a status AWS adds later is recorded rather than refused.';
COMMENT ON COLUMN admin_customer_snapshots.pool_created_at IS
  'Cognito''s UserCreateDate. "New accounts per month" is counted from this, not from seen_on, so backfilling a missed night does not invent signups.';
COMMENT ON COLUMN admin_customer_snapshots.partial IS
  'TRUE when the pool listing behind this day was cut short by the app''s page cap, so the day is missing accounts that exist. Such a day is never used as the previous side of a snapshot diff (every unreached account would look deleted); it still counts for the newest-day census, where the accounts it did reach are real.';

-- ---------------------------------------------------------------------------
-- admin_customer_events
-- The lifecycle log: what happened to an account and when, whoever did it.
--
-- Written by three sources:
--   'console'        this app did it and knows at the moment it happened
--                    (an invitation sent, an invitation revoked)
--   'directory_diff' the nightly comparison of two snapshot days inferred it
--   'main_db'        the main app database says it (users.deleted_at, set by
--                    the consumer app's delete-my-account flow)
--
-- UNIQUE (sub, event, at) makes every writer idempotent: the diff dates its
-- events at midnight of the snapshot day, so re-running the same night writes
-- nothing new, and the main-database sweep dates a deletion at users.deleted_at
-- itself, so it cannot be recorded twice however often the job runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_customer_events (
  id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The account the event is about. Not a foreign key to anything: the whole
  -- point of this table is to outlive the row the sub used to name.
  sub     TEXT        NOT NULL,
  event   TEXT        NOT NULL,
  -- When it happened, as accurately as the source knows. The console knows to
  -- the second; the nightly diff only knows "by this snapshot", so it dates
  -- its events at 00:00 UTC of the snapshot day, which is also what makes the
  -- unique key idempotent.
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source  TEXT        NOT NULL,
  -- Whatever the writer knew that a person reading the log would want: the
  -- email, the statuses either side of a change, the invitation id, the
  -- users.id behind a deleted_in_app. Never a credential and never a password.
  details JSONB,

  CONSTRAINT admin_customer_events_event_chk CHECK (event IN (
    -- An operator created the pool account and Cognito emailed the temporary
    -- password (source 'console', written by createInvite).
    'invited',
    -- The account left FORCE_CHANGE_PASSWORD for CONFIRMED: the person set
    -- their own password and has signed in.
    'confirmed',
    -- Enabled went TRUE -> FALSE. The person cannot sign in.
    'disabled',
    -- Enabled went FALSE -> TRUE.
    'enabled',
    -- The account is gone from the pool. Either an operator revoked an unused
    -- invitation here (source 'console') or the sub stopped appearing in the
    -- directory (source 'directory_diff'), which also covers a deletion made
    -- in the AWS console.
    'deleted',
    -- A sub that was absent yesterday and is present today. Rare and worth
    -- seeing: it means either a missed snapshot night or a restored account,
    -- and it stops a gap in the history from reading as a signup.
    'reappeared',
    -- The consumer app soft-deleted the person (users.deleted_at), which is
    -- the self-service "delete my account" flow. Counted as churn beside
    -- 'deleted', and deduped against it per sub per month so one departure is
    -- never counted twice.
    'deleted_in_app'
  )),

  CONSTRAINT admin_customer_events_source_chk CHECK (source IN (
    'console', 'directory_diff', 'main_db'
  )),

  -- One writer, one event, one instant. See the note above: this is what
  -- makes every path here safely repeatable.
  CONSTRAINT admin_customer_events_sub_event_at_key UNIQUE (sub, event, at)
);

CREATE INDEX IF NOT EXISTS idx_admin_customer_events_at
  ON admin_customer_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_customer_events_sub_at
  ON admin_customer_events (sub, at DESC);
-- "Deletions per month", "confirmations per month": a scan by event and date.
CREATE INDEX IF NOT EXISTS idx_admin_customer_events_event_at
  ON admin_customer_events (event, at DESC);

COMMENT ON TABLE admin_customer_events IS
  'Customer account lifecycle: invited, confirmed, disabled, enabled, deleted, reappeared, deleted_in_app. Written by the console''s own actions (source console), by the nightly snapshot diff (directory_diff) and from the main app database''s users.deleted_at (main_db). Rows outlive the account they describe, which is the only way churn is measurable — Cognito has no deletion event. Mirrors docs/sql/014_customer_statistics.sql.';
COMMENT ON COLUMN admin_customer_events.at IS
  'When it happened, to the accuracy of the source. The nightly diff uses 00:00 UTC of the snapshot day, which together with the unique key makes a repeated run a no-op.';
COMMENT ON COLUMN admin_customer_events.details IS
  'Context for a person reading the log: email, the statuses either side of a change, the invitation or user id. Never a credential.';

-- ---------------------------------------------------------------------------
-- admin_pool_metrics_daily
-- The AWS/Cognito CloudWatch counters for the customer pool, one row per UTC
-- day, from one cloudwatch:GetMetricData call a night.
--
-- Pool-level only, and that is a property of the tier rather than of this
-- schema: per-user auth events need the Cognito Plus tier ($0.020 per monthly
-- active user, no free allowance) and this deployment is on Essentials. What
-- is free is the whole pool's counts per day, which is enough for a
-- "sign-ins per day" chart; who signed in comes from the main app database's
-- users.last_seen_at instead.
--
-- Sum is successes and SampleCount is attempts, so sign_in_attempts minus
-- sign_ins is the number of failed sign-ins.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_pool_metrics_daily (
  -- The UTC day, which is how CloudWatch buckets a 86 400-second period.
  day                DATE        PRIMARY KEY,
  -- SignInSuccesses, Sum.
  sign_ins           INTEGER     NOT NULL DEFAULT 0,
  -- SignInSuccesses, SampleCount: every attempt, successful or not.
  sign_in_attempts   INTEGER     NOT NULL DEFAULT 0,
  -- SignUpSuccesses, Sum. Zero while the consumer app has no self-service
  -- sign-up: an invited account is created by AdminCreateUser, which is not a
  -- sign-up.
  sign_ups           INTEGER     NOT NULL DEFAULT 0,
  -- TokenRefreshSuccesses, Sum. A proxy for sessions kept alive.
  token_refreshes    INTEGER     NOT NULL DEFAULT 0,
  -- SignInThrottles, Sum. Anything other than 0 is worth an operator's
  -- attention: Cognito is rate-limiting the pool.
  throttles          INTEGER     NOT NULL DEFAULT 0,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin_pool_metrics_daily IS
  'AWS/Cognito CloudWatch counters for the customer user pool, one row per UTC day, written by the cognito_directory job from cloudwatch:GetMetricData at a 86400s period. Sum is successes, SampleCount is attempts. Pool-level only: per-user auth events need the Cognito Plus tier, which this deployment does not use. Mirrors docs/sql/014_customer_statistics.sql.';
COMMENT ON COLUMN admin_pool_metrics_daily.sign_in_attempts IS
  'SampleCount of SignInSuccesses: all attempts. attempts - sign_ins is the failed sign-ins for the day.';

-- ---------------------------------------------------------------------------
-- Seed: the cognito_directory integration
--
-- 02:30 America/Toronto. Late enough that the UTC day the snapshot is stamped
-- with is unambiguous (02:30 in Toronto is 06:30 or 07:30 UTC, well clear of
-- midnight either side of a DST change), and quiet enough not to compete with
-- anything a person is doing. The window also matters for `deleted_in_app`:
-- the sweep looks 7 days back, so one missed night changes nothing.
--
-- provider 'aws' — the credential is the ECS task role resolved by the AWS
-- SDK's default chain, so requires_api_key is FALSE and api_key_env is NULL,
-- exactly as aws_costs. base_url is the Cognito endpoint for orientation on
-- the Integrations page; the SDK builds its own, nothing reads this value and
-- editing it changes nothing (see src/lib/customers/cognito.ts).
--
-- settings.metricsDays is how many days of CloudWatch metrics each run
-- re-fetches, ending yesterday. 35 by default: a month of bars is always
-- complete, every day in the window is replaced each run so a late-arriving
-- figure is corrected, and CloudWatch charges nothing for it.
-- ---------------------------------------------------------------------------
INSERT INTO admin_integrations
  (key, name, description, provider, base_url, requires_api_key, api_key_env,
   schedule_frequency, schedule_hour, schedule_minute, settings) VALUES
  ('cognito_directory', 'Cognito directory', 'Nightly snapshot of the customer Cognito pool, the lifecycle events the snapshot diff reveals (deletions, disablements, confirmations), the self-service deletions the consumer app recorded, and the pool''s daily CloudWatch sign-in and sign-up counters. Free: no AWS call here is charged.', 'aws', 'https://cognito-idp.us-west-2.amazonaws.com', FALSE, NULL, 'daily', 2, 30, '{"metricsDays": 35}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: endpoints (keys, methods and paths must match
-- src/lib/admin-access/endpoint-registry.ts, with the path spelled the way
-- Next spells it)
--
-- `statistics` is a static segment under /api/v1/admin/customers and Next
-- matches it ahead of [id], the same way `invites` already is; the activity
-- endpoint lives under [id] and needs no such care.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.customers.statistics', 'GET', '/api/v1/admin/customers/statistics',    'Customer statistics',  'Population and engagement figures: accounts by status, DAU/WAU/MAU, new and deleted per month, churn, retention by sign-up cohort, the invitation funnel, the pool''s daily sign-in counters, request and error volume, and the largest tenants. Reads the admin database and the main app database; never calls AWS.', 'customers', 'admin', 'api', FALSE),
  ('admin.customers.activity',   'GET', '/api/v1/admin/customers/[id]/activity', 'Customer activity',    'One customer''s own figures: when they were last seen, their daily request and error counts, the size of their tenants, and every lifecycle event recorded for their Cognito sub. Reads the admin database and the main app database; never calls AWS.',                                                        'customers', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Endpoint -> actions (ANY-OF). Both are reads on the Customers page, so each
-- takes the same three actions 010 gave the Customers reads, and the same
-- three src/lib/admin-access/endpoint-registry.ts lists as their defaults:
-- can_read_user_list, can_read_user_detail, can_invite_users. (Someone who
-- may invite must be able to see how the invitations are going.)
--
-- The actions are named here rather than derived from admin_page_actions.
-- Deriving is tempting — "whoever may open the page may read the figures on
-- it" — but it silently depends on the `customers` page row already having
-- action links: if the SELECT finds nothing, the INSERT inserts nothing, both
-- endpoints end up with **zero** actions, and evaluateRule() treats an
-- endpoint with no actions and require_super_admin = FALSE as reachable by
-- any admin. Naming the keys cannot fail that way: an action key that is
-- missing simply is not linked, and the three below are seeded by 001 and
-- 010. require_super_admin stays FALSE only because these rows are present.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE e.key IN ('admin.customers.statistics', 'admin.customers.activity')
  AND a.key IN ('can_read_user_list', 'can_read_user_detail', 'can_invite_users')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
