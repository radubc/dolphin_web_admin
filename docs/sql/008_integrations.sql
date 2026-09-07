-- Integrations: providers, schedules, runs, quote and exchange-rate caches
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 007_constants_sync_and_jobs.sql. Re-running is safe: tables and
-- indexes are created IF NOT EXISTS, every insert is guarded by ON CONFLICT,
-- and the one constraint that is replaced is dropped IF EXISTS first.
--
-- Why this file exists
--   Three things the console needs come from outside: the TwelveData
--   reference lists that fill the market-data catalogs, end-of-day quotes for
--   the symbols the consumer app shows, and the Bank of Canada's daily
--   exchange rates. Until now none of that existed here; the macOS app did it
--   itself, once per device. Moving it into the admin app means one download
--   for everybody, a cache the consumer app can read, and an operator page
--   that says when each provider last answered.
--
--   * admin_integrations is the definition of one outbound provider call:
--     its address, whether it needs a key (the key itself is never stored —
--     only the name of the environment variable it is read from), its
--     schedule, and a small JSONB settings object. Three rows are seeded and
--     the UI never creates a fourth: adding an integration is a code change.
--
--   * admin_integration_runs records every execution — scheduled, started by
--     an operator, or triggered by a consumer request the cache could not
--     answer — with progress, counters and outcome. Runs execute inside the
--     app process in batches (each batch its own transaction), exactly like
--     the Constants jobs, so a restart mid-run loses nothing already written;
--     a running row with a stale heartbeat_at is reported as interrupted.
--
--   * admin_quote_symbols / admin_quotes are the quote watch list and its
--     cache: one row per symbol and trading day. admin_currency_pairs /
--     admin_exchange_rates are the same for currencies, one row per pair and
--     observation day. Items enter both lists either by hand on the
--     Integrations page or the first time the consumer app asks for one.
--
-- What this adds
--   admin_integrations        provider definitions (3 rows seeded)
--   admin_integration_runs    run records
--   admin_quote_symbols       the quote watch list
--   admin_quotes              cached end-of-day quotes
--   admin_currency_pairs      the currency pair watch list
--   admin_exchange_rates      cached daily rates
--   admin_actions             two rows: can_read_integrations,
--                             can_write_integrations
--   admin_pages               the `integrations` page (nav_order 25) and its
--                             action links
--   admin_endpoints           the thirteen admin endpoints and the two
--                             service (API key) endpoints, mirroring
--                             src/lib/admin-access/endpoint-registry.ts
--   admin_endpoint_actions    read endpoints: either integration action;
--                             write endpoints: can_write_integrations
--   admin_endpoints_auth_kind_chk is replaced so auth_kind may also be
--                             'service' (an API_KEYS machine client, gated by
--                             the key and not by the access map).
--
-- Nothing is changed or removed. The catalog tables the TwelveData download
-- fills (stocks, etfs, cryptocurrencies) are untouched by this file; the
-- download only ever INSERTs rows they do not already have.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_integrations
-- One row per outbound provider call the app makes. `key` is the contract
-- with code (src/lib/integrations/types.ts INTEGRATION_KEYS); the rows are
-- seeded here and never created from the UI.
-- api_key_env names an environment variable. The key itself is never stored
-- in, or read from, this database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_integrations (
  key                   TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  provider              TEXT NOT NULL,
  -- The provider's base address, editable by an operator. Paths are appended
  -- by the code, never stored.
  base_url              TEXT NOT NULL,
  requires_api_key      BOOLEAN NOT NULL DEFAULT FALSE,
  -- Name of the environment variable holding the key; NULL when none is used.
  api_key_env           TEXT,
  is_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  schedule_frequency    TEXT NOT NULL DEFAULT 'daily',
  schedule_hour         SMALLINT NOT NULL DEFAULT 1,
  schedule_minute       SMALLINT NOT NULL DEFAULT 0,
  -- 0 = Sunday. Only read when schedule_frequency = 'weekly'.
  schedule_weekday      SMALLINT NOT NULL DEFAULT 1,
  -- Capped at 28 so every month has the day. Only read for 'monthly'.
  schedule_day_of_month SMALLINT NOT NULL DEFAULT 1,
  schedule_timezone     TEXT NOT NULL DEFAULT 'America/Toronto',
  -- Provider-specific knobs (catalogs, batchSize, creditsPerMinute).
  settings              JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_at           TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  -- When the scheduler will next start it; NULL while 'off' or disabled, and
  -- NULL on a fresh row until the first scheduler tick computes it.
  next_run_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES admin_users (id),

  CONSTRAINT admin_integrations_provider_chk
    CHECK (provider IN ('twelvedata', 'bank_of_canada')),
  CONSTRAINT admin_integrations_frequency_chk
    CHECK (schedule_frequency IN ('daily', 'weekly', 'monthly', 'off')),
  CONSTRAINT admin_integrations_hour_chk    CHECK (schedule_hour BETWEEN 0 AND 23),
  CONSTRAINT admin_integrations_minute_chk  CHECK (schedule_minute BETWEEN 0 AND 59),
  CONSTRAINT admin_integrations_weekday_chk CHECK (schedule_weekday BETWEEN 0 AND 6),
  CONSTRAINT admin_integrations_day_chk     CHECK (schedule_day_of_month BETWEEN 1 AND 28)
);

CREATE INDEX IF NOT EXISTS idx_admin_integrations_next_run_at
  ON admin_integrations (next_run_at);

COMMENT ON TABLE admin_integrations IS
  'One outbound provider call each: address, key requirement (by env var name, never the key), schedule and settings. Seeded in code order; the UI edits rows but never creates them.';
COMMENT ON COLUMN admin_integrations.api_key_env IS
  'Name of the environment variable the API key is read from. The key itself is never stored here.';

-- ---------------------------------------------------------------------------
-- admin_integration_runs
-- Every execution of an integration. status stores queued / running /
-- succeeded / failed only; `interrupted` is derived on read from a stale
-- heartbeat_at, exactly as admin_constant_jobs does it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_integration_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_key  TEXT NOT NULL REFERENCES admin_integrations (key),
  trigger          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  -- Items the run set out to process; NULL until counted.
  total            INTEGER,
  processed        INTEGER NOT NULL DEFAULT 0,
  created          INTEGER NOT NULL DEFAULT 0,
  updated          INTEGER NOT NULL DEFAULT 0,
  unchanged        INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  -- The request as received (forced, symbols asked for), for the record.
  request          JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by     UUID REFERENCES admin_users (id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  -- Touched between batches while running; stale = interrupted.
  heartbeat_at     TIMESTAMPTZ,

  CONSTRAINT admin_integration_runs_trigger_chk
    CHECK (trigger IN ('scheduled', 'manual', 'on_demand')),
  CONSTRAINT admin_integration_runs_status_chk
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_admin_integration_runs_key_created_at
  ON admin_integration_runs (integration_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_integration_runs_status
  ON admin_integration_runs (status);

COMMENT ON TABLE admin_integration_runs IS
  'Integration executions: trigger, progress, counters, outcome. A running run with a stale heartbeat_at was interrupted by a process restart; nothing already written is lost, rerun it.';

-- ---------------------------------------------------------------------------
-- admin_quote_symbols
-- The quote watch list. `canonical` is what is sent to the provider and what
-- the consumer app asks for: SYMBOL:EXCHANGE when an exchange is set, the
-- bare symbol otherwise ('AAPL', 'SHOP:TSX', 'BTC/USD').
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_quote_symbols (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  -- The catalog's exchange for stocks and ETFs; NULL for crypto.
  exchange       TEXT,
  canonical      TEXT NOT NULL,
  -- From the admin catalog when the symbol was found there.
  name           TEXT,
  currency       TEXT,
  source         TEXT NOT NULL DEFAULT 'manual',
  -- Inactive symbols are kept but skipped by the daily run.
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_quoted_at TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES admin_users (id),

  CONSTRAINT admin_quote_symbols_canonical_key UNIQUE (canonical),
  CONSTRAINT admin_quote_symbols_kind_chk   CHECK (kind IN ('stock', 'etf', 'crypto')),
  CONSTRAINT admin_quote_symbols_source_chk CHECK (source IN ('manual', 'request'))
);

CREATE INDEX IF NOT EXISTS idx_admin_quote_symbols_is_active
  ON admin_quote_symbols (is_active);
CREATE INDEX IF NOT EXISTS idx_admin_quote_symbols_kind
  ON admin_quote_symbols (kind);

COMMENT ON TABLE admin_quote_symbols IS
  'Quote watch list: the symbols the TwelveData quote integration keeps current. Entered by hand on the Integrations page or the first time the consumer app asks for one (source = request).';

-- ---------------------------------------------------------------------------
-- admin_quotes
-- One end-of-day quote per canonical symbol and trading day.
-- NUMERIC(20,8) rather than the main database's NUMERIC(11,4): crypto prices
-- need both the range and the fractional digits.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_quotes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The canonical symbol; see admin_quote_symbols.canonical.
  symbol         TEXT NOT NULL,
  quote_date     DATE NOT NULL,
  close          NUMERIC(20, 8) NOT NULL,
  open           NUMERIC(20, 8),
  high           NUMERIC(20, 8),
  low            NUMERIC(20, 8),
  -- '' when the provider reported none; the column is NOT NULL.
  currency       TEXT NOT NULL DEFAULT '',
  change         NUMERIC(20, 8),
  -- Stored as a fraction (0.0064 = 0.64 %), not the provider's percent units.
  percent_change NUMERIC(12, 8),
  provider       TEXT NOT NULL DEFAULT 'twelvedata',
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_quotes_symbol_date_key UNIQUE (symbol, quote_date)
);

CREATE INDEX IF NOT EXISTS idx_admin_quotes_symbol_quote_date
  ON admin_quotes (symbol, quote_date DESC);

COMMENT ON TABLE admin_quotes IS
  'Cached end-of-day quotes, one row per canonical symbol and trading day. Wider precision than the main app database on purpose: crypto prices do not fit NUMERIC(11,4).';

-- ---------------------------------------------------------------------------
-- admin_currency_pairs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_currency_pairs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency TEXT NOT NULL,
  to_currency   TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_rated_at TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES admin_users (id),

  CONSTRAINT admin_currency_pairs_from_to_key UNIQUE (from_currency, to_currency),
  CONSTRAINT admin_currency_pairs_from_chk   CHECK (from_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT admin_currency_pairs_to_chk     CHECK (to_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT admin_currency_pairs_differ_chk CHECK (from_currency <> to_currency),
  CONSTRAINT admin_currency_pairs_source_chk CHECK (source IN ('manual', 'request'))
);

CREATE INDEX IF NOT EXISTS idx_admin_currency_pairs_is_active
  ON admin_currency_pairs (is_active);

COMMENT ON TABLE admin_currency_pairs IS
  'Currency pair watch list: the pairs the Bank of Canada integration keeps current. Entered by hand or the first time the consumer app asks for one (source = request).';

-- ---------------------------------------------------------------------------
-- admin_exchange_rates
-- One rate per pair and observation day. NUMERIC(20,10) rather than the main
-- database's NUMERIC(10,10), which cannot hold a rate of 1 or more.
-- Every run also caches each published FX{X}CAD series as an X -> CAD row, so
-- an on-demand lookup can be derived without calling the provider again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_exchange_rates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency TEXT NOT NULL,
  to_currency   TEXT NOT NULL,
  date          DATE NOT NULL,
  -- How many to_currency one from_currency buys on `date`.
  rate          NUMERIC(20, 10) NOT NULL,
  -- 'boc'     read straight from a published FX{X}CAD series (inverted for CAD -> X)
  -- 'derived' the ratio of two such series, for a pair with CAD on neither side
  source        TEXT NOT NULL DEFAULT 'boc',
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT admin_exchange_rates_from_to_date_key UNIQUE (from_currency, to_currency, date),
  CONSTRAINT admin_exchange_rates_source_chk CHECK (source IN ('boc', 'derived'))
);

CREATE INDEX IF NOT EXISTS idx_admin_exchange_rates_pair_date
  ON admin_exchange_rates (from_currency, to_currency, date DESC);

COMMENT ON TABLE admin_exchange_rates IS
  'Cached daily exchange rates, one row per pair and observation day. Wider precision than the main app database on purpose: NUMERIC(10,10) there cannot hold a rate of 1 or more.';

-- ---------------------------------------------------------------------------
-- Seed: the three integrations. Times are wall-clock in schedule_timezone and
-- deliberately staggered: quotes first, rates once the previous day's
-- observation is published, catalogs last because they are the longest.
-- ---------------------------------------------------------------------------
INSERT INTO admin_integrations
  (key, name, description, provider, base_url, requires_api_key, api_key_env,
   schedule_frequency, schedule_hour, schedule_minute, settings) VALUES
  ('twelvedata_quotes',    'TwelveData quotes',       'End-of-day quotes for every active symbol on the quote watch list, cached one row per symbol and trading day.',                              'twelvedata',     'https://api.twelvedata.com',       TRUE,  'TWELVEDATA_API_KEY', 'daily', 1, 0,  '{"batchSize": 8, "creditsPerMinute": 8}'::jsonb),
  ('bank_of_canada_rates', 'Bank of Canada rates',    'Daily exchange rates for every active currency pair, from the Bank of Canada Valet API. No key needed.',                                     'bank_of_canada', 'https://www.bankofcanada.ca/valet', FALSE, NULL,                 'daily', 1, 30, '{}'::jsonb),
  ('twelvedata_catalogs',  'TwelveData catalogs',     'Downloads the stock, ETF and cryptocurrency reference lists and inserts the rows the admin catalogs do not have yet. Never updates or deletes.', 'twelvedata',   'https://api.twelvedata.com',       FALSE, NULL,                 'daily', 2, 0,  '{"catalogs": ["stocks", "etfs", "cryptocurrencies"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: the two actions
-- ---------------------------------------------------------------------------
INSERT INTO admin_actions (key, description, category) VALUES
  ('can_read_integrations',  'View integrations, watch lists and run history',                                  'integrations'),
  ('can_write_integrations', 'Edit integration settings and schedules, run integrations, manage watch lists',    'integrations')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: the Integrations page (nav_order 25, between Constants and User
-- Management) and its action links
-- ---------------------------------------------------------------------------
INSERT INTO admin_pages (key, kind, path, name, description, nav_order, require_super_admin) VALUES
  ('integrations', 'page', '/integrations', 'Integrations', 'External providers: catalog downloads, quotes and exchange rates, and when they run.', 25, FALSE)
ON CONFLICT (key) DO NOTHING;

INSERT INTO admin_page_actions (page_id, action_id)
SELECT p.id, a.id FROM admin_pages p CROSS JOIN admin_actions a
WHERE p.key = 'integrations'
  AND a.key IN ('can_read_integrations', 'can_write_integrations')
ON CONFLICT (page_id, action_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- admin_endpoints.auth_kind gains 'service'
-- An API_KEYS machine client (serviceHandler): the key is the credential and
-- the access map's rule is not applied. The row still exists so the endpoint
-- appears on the Services page and its calls are counted.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_endpoints DROP CONSTRAINT IF EXISTS admin_endpoints_auth_kind_chk;
ALTER TABLE admin_endpoints ADD CONSTRAINT admin_endpoints_auth_kind_chk
  CHECK (auth_kind IN ('public', 'session', 'admin', 'service'));

-- ---------------------------------------------------------------------------
-- Seed: endpoints (keys, methods and paths must match
-- src/lib/admin-access/endpoint-registry.ts)
-- ---------------------------------------------------------------------------
INSERT INTO admin_endpoints (key, method, path, name, description, category, auth_kind, rate_limit_policy, require_super_admin) VALUES
  ('admin.integrations.list',                 'GET',    '/api/v1/admin/integrations',                              'List integrations',      'The three integrations with their schedule, settings, latest run and whether the scheduler runs in this process. Never returns an API key.', 'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.update',               'PATCH',  '/api/v1/admin/integrations/[key]',                        'Update integration',     'Base URL, enabled flag, schedule and settings. Recomputes the next scheduled run.',                                                          'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.run',                  'POST',   '/api/v1/admin/integrations/[key]/run',                    'Run integration',        'Starts a run now. 409 while one is already live for that integration; 422 when the integration needs an API key that is not configured.',    'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.runs.list',            'GET',    '/api/v1/admin/integrations/[key]/runs',                   'List integration runs',  'Recent runs for one integration, newest first, with progress and counters.',                                                                 'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.runs.get',             'GET',    '/api/v1/admin/integrations/[key]/runs/[runId]',           'Get integration run',    'One run by id, for polling progress.',                                                                                                      'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.quote_symbols.list',   'GET',    '/api/v1/admin/integrations/quote-symbols',                'List quote symbols',     'One page of the quote watch list, each symbol with its newest cached quote.',                                                                'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.quote_symbols.create', 'POST',   '/api/v1/admin/integrations/quote-symbols',                'Add quote symbol',       'Adds a symbol to the watch list, filling name and currency from the admin catalog when it is found there.',                                  'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.quote_symbols.update', 'PATCH',  '/api/v1/admin/integrations/quote-symbols/[id]',           'Update quote symbol',    'Activates or deactivates one watched symbol.',                                                                                              'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.quote_symbols.delete', 'DELETE', '/api/v1/admin/integrations/quote-symbols/[id]',           'Remove quote symbol',    'Removes the watch row. Cached quotes are kept.',                                                                                            'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.currency_pairs.list',  'GET',    '/api/v1/admin/integrations/currency-pairs',               'List currency pairs',    'One page of the currency pair watch list, each pair with its newest cached rate.',                                                           'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.currency_pairs.create','POST',   '/api/v1/admin/integrations/currency-pairs',               'Add currency pair',      'Adds a pair to the watch list. Codes are three uppercase letters and must differ.',                                                          'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.currency_pairs.update','PATCH',  '/api/v1/admin/integrations/currency-pairs/[id]',          'Update currency pair',   'Activates or deactivates one watched pair.',                                                                                                'integrations', 'admin',   'api',     FALSE),
  ('admin.integrations.currency_pairs.delete','DELETE', '/api/v1/admin/integrations/currency-pairs/[id]',          'Remove currency pair',   'Removes the watch row. Cached rates are kept.',                                                                                             'integrations', 'admin',   'api',     FALSE),
  ('service.quotes.lookup',                   'GET',    '/api/v1/service/quotes',                                  'Quote lookup',           'Machine clients: the newest cached quote per symbol, fetching any symbol with no quote from today. Unknown symbols join the watch list.',    'integrations', 'service', 'service', FALSE),
  ('service.exchange_rates.lookup',           'GET',    '/api/v1/service/exchange-rates',                          'Exchange rate lookup',   'Machine clients: the newest cached rate per pair, fetching any pair with no rate from today. Unknown pairs join the watch list.',          'integrations', 'service', 'service', FALSE)
ON CONFLICT (key) DO NOTHING;

-- Endpoint -> actions (ANY-OF). Reads take either integration action; writes
-- take can_write_integrations. The two service endpoints get no rows: the API
-- key is the credential and the rule is not applied to them.
INSERT INTO admin_endpoint_actions (endpoint_id, action_id)
SELECT e.id, a.id FROM admin_endpoints e CROSS JOIN admin_actions a
WHERE (e.key IN ('admin.integrations.list',
                 'admin.integrations.runs.list',
                 'admin.integrations.runs.get',
                 'admin.integrations.quote_symbols.list',
                 'admin.integrations.currency_pairs.list')
         AND a.key IN ('can_read_integrations', 'can_write_integrations'))
   OR (e.key IN ('admin.integrations.update',
                 'admin.integrations.run',
                 'admin.integrations.quote_symbols.create',
                 'admin.integrations.quote_symbols.update',
                 'admin.integrations.quote_symbols.delete',
                 'admin.integrations.currency_pairs.create',
                 'admin.integrations.currency_pairs.update',
                 'admin.integrations.currency_pairs.delete')
         AND a.key = 'can_write_integrations')
ON CONFLICT (endpoint_id, action_id) DO NOTHING;

COMMIT;
