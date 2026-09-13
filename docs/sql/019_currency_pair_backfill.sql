-- Currency pair history backfill: the endpoint behind "Fetch 6 months"
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 018. Re-running is safe: both inserts are guarded by ON CONFLICT
-- and nothing is deleted, altered or dropped.
--
-- Why this file exists
--   Adding a currency pair by hand used to insert the watch row and stop
--   there: no rate appeared until that night's bank_of_canada_rates run, or
--   until the consumer app happened to ask for the pair. The owner saw exactly
--   that on stage on 2026-09-12 — a new pair with an empty "Latest rate"
--   column and a Refresh button that only re-read the same empty row.
--
--   The app now fetches the pair's last six months (today - 182 days -> today)
--   in the same request, as one ranged Bank of Canada call recorded as an
--   on_demand run. That needed **no** schema change and no new endpoint: it is
--   the existing POST /api/v1/admin/integrations/currency-pairs doing more,
--   and its answer grew from the pair to { pair, history }.
--
--   What did need a new endpoint is the same thing for a pair that is already
--   on the list — the "Fetch 6 months" button beside Refresh in the pair's
--   download-history drawer:
--
--     POST /api/v1/admin/integrations/currency-pairs/[id]/backfill
--
--   Registering it here is what puts it on the Access Map and the Services
--   page and lets a non-super-admin role reach it; an endpoint with no row is
--   super-admin only.
--
-- What this changes
--   admin_endpoints          one row: admin.integrations.currency_pairs.backfill,
--                            mirroring src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions   that endpoint (a write: it stores rates and may
--                            stamp the pair current) takes can_write_integrations,
--                            the same action 008 gave every other integrations
--                            write, named explicitly so it cannot end up with
--                            no actions at all
--
-- What this does NOT change
--   No table, column, constraint or index is created, altered or dropped. No
--   row of admin_currency_pairs or admin_exchange_rates is touched — the rates
--   this endpoint stores are written by the app, at the operator's request.
--   No action, role, page or grant is added or changed, and the create
--   endpoint's own row (admin.integrations.currency_pairs.create, seeded by
--   008) is left exactly as it is: its key, method and path are unchanged and
--   only its response body grew.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The endpoint (key, method and path must match
--    src/lib/admin-access/endpoint-registry.ts)
--
-- `backfill` is a static segment under the existing
-- /api/v1/admin/integrations/currency-pairs/[id], the same shape as the
-- `rates` segment 017 registered.
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.integrations.currency_pairs.backfill', 'POST', '/api/v1/admin/integrations/currency-pairs/[id]/backfill', 'Fetch currency pair history', 'Downloads the last six months for one watched pair (today - 182 days -> today) in a single ranged Bank of Canada call, recorded as an on_demand run, and stores the observation days the cache did not have. Answers the watch row with what the fetch produced: how many days it now covers, the newest of them, and whether the pair was stamped current. A pair the Bank publishes no series for keeps the reason in last_error. An inactive pair is refused with 409 — switching a pair off is an operator decision that no fetch overturns — and a provider that is down, disabled or already running is not an error but a status on the answer. Takes no request body: the window is fixed, so the button and a manual add mean the same thing.', 'integrations', 'admin', 'api', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Endpoint -> actions (ANY-OF). A write on the Integrations page, so it takes
-- the one action 008 gave every other integrations write:
-- can_write_integrations. Read-only operators (can_read_integrations) may open
-- the history drawer — 017 registered that read for both actions — but they
-- may not spend a provider call or change a watch row from it.
--
-- Named explicitly rather than derived from admin_page_actions, for the reason
-- 013 and 017 give: a derived insert is a no-op when the page row or its links
-- are missing, which would leave the endpoint with **zero** actions — and
-- evaluateRule() treats an endpoint with no actions and require_super_admin =
-- FALSE as reachable by any admin. The action comes from 008, which the header
-- already requires to have run.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE e.key = 'admin.integrations.currency_pairs.backfill'
  AND a.key = 'can_write_integrations'
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
