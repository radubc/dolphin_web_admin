-- Two more integrations: the ISO 10383 MIC register, and the Alpha Vantage
-- quote fallback (plus the column that routes between the two quote providers)
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 008_integrations.sql. Re-running is safe: the column is added
-- IF NOT EXISTS, both constraints are dropped IF EXISTS before being created,
-- and both seed inserts are guarded by ON CONFLICT.
--
-- Why this file exists
--   Two gaps were left by 008, and both are gaps in data the consumer app
--   needs rather than gaps in the console.
--
--   * The admin `markets` catalog is empty and nothing the app talks to fills
--     it. The list of market identifier codes is published, free and without a
--     key, by ISO 20022 as a single CSV: the ISO 10383 register, about 2 900
--     rows, whose columns are exactly the ones `markets` holds. So the fifth
--     integration downloads it and inserts the MICs the catalog does not have
--     yet, on the same insert-only terms as the TwelveData catalog download —
--     nothing existing is updated, nothing is ever deleted.
--
--   * TwelveData's free plan refuses Canadian and most other non-US listings:
--     a quote for SHOP:TSX comes back as an error, having spent the credit.
--     The macOS app already solved this with Alpha Vantage as a per-symbol
--     fallback, and this brings that fallback into the admin app. It is a
--     fallback and not a schedule: it runs inside the twelvedata_quotes run,
--     over the symbols that run could not fetch, which is why its seeded
--     schedule_frequency is 'off'.
--
--   * admin_quote_symbols.provider is what makes the pair of them affordable.
--     Alpha Vantage's free tier is 25 requests a day and 5 a minute, with no
--     batch endpoint, so guessing wrong twice a day is not something the quota
--     survives. The column records which provider last served the symbol: one
--     Alpha Vantage answered for skips TwelveData on later runs (saving the
--     credit and the daily miss), and one TwelveData answered for is never
--     offered to Alpha Vantage.
--
-- What this changes
--   admin_integrations_provider_chk   replaced, so provider may also be
--                                     'iso20022' or 'alpha_vantage'
--   admin_quote_symbols.provider      new nullable column, with a CHECK
--   admin_integrations                two seeded rows: iso_mic_markets and
--                                     alpha_vantage_quotes
--
-- No new endpoints, actions or pages. The integration routes are keyed by
-- [key] and the two new rows are reached by the endpoints 008 already
-- registered, under the same can_read_integrations / can_write_integrations
-- rules.
--
-- Nothing is changed or removed. The `markets` catalog itself is untouched by
-- this file: the download only ever INSERTs MICs it does not already hold.

BEGIN;

-- ---------------------------------------------------------------------------
-- admin_integrations.provider gains two values
-- The set mirrors INTEGRATION_PROVIDERS in src/lib/integrations/types.ts.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_integrations DROP CONSTRAINT IF EXISTS admin_integrations_provider_chk;
ALTER TABLE admin_integrations ADD CONSTRAINT admin_integrations_provider_chk
  CHECK (provider IN ('twelvedata', 'bank_of_canada', 'iso20022', 'alpha_vantage'));

-- ---------------------------------------------------------------------------
-- admin_quote_symbols.provider
-- Which provider last served this symbol. NULL until the first quote is
-- saved, and never cleared by a failure: the memory is precisely what stops
-- the next run from paying to be refused again.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_quote_symbols ADD COLUMN IF NOT EXISTS provider TEXT;

ALTER TABLE admin_quote_symbols DROP CONSTRAINT IF EXISTS admin_quote_symbols_provider_chk;
ALTER TABLE admin_quote_symbols ADD CONSTRAINT admin_quote_symbols_provider_chk
  CHECK (provider IS NULL
         OR provider IN ('twelvedata', 'bank_of_canada', 'iso20022', 'alpha_vantage'));

COMMENT ON COLUMN admin_quote_symbols.provider IS
  'Which provider last served this symbol. NULL until a quote is saved. A symbol Alpha Vantage owns skips TwelveData on later runs, and one TwelveData owns never spends an Alpha Vantage request (free tier: 25 a day).';

-- ---------------------------------------------------------------------------
-- Seed: the two new integrations
--
-- iso_mic_markets runs weekly rather than daily, on Monday at 02:30 local:
-- the register changes on the order of a few rows a month, and a 600 KB
-- download every night to insert nothing is not a schedule, it is noise. 02:30
-- keeps it clear of the 02:00 TwelveData catalog download.
--
-- alpha_vantage_quotes is seeded 'off' on purpose. It is a fallback: the
-- twelvedata_quotes run calls it for the symbols TwelveData did not return,
-- and 'Run now' refreshes the symbols it already owns. A schedule of its own
-- would spend the 25 daily requests before the quote run could use them.
-- ---------------------------------------------------------------------------
INSERT INTO admin_integrations
  (key, name, description, provider, base_url, requires_api_key, api_key_env,
   schedule_frequency, schedule_hour, schedule_minute, schedule_weekday, settings) VALUES
  ('iso_mic_markets',      'ISO 10383 markets',    'Downloads the ISO 10383 MIC register published by ISO 20022 and inserts the markets the admin catalog does not have yet. Never updates or deletes. No key needed.',                                'iso20022',      'https://www.iso20022.org',  FALSE, NULL,                     'weekly', 2, 30, 1, '{"includeExpired": false}'::jsonb),
  ('alpha_vantage_quotes', 'Alpha Vantage quotes', 'Fallback for symbols TwelveData does not serve (TSX and other non-US listings). Runs inside the TwelveData quote run, one symbol per request; its own schedule is normally off.', 'alpha_vantage', 'https://www.alphavantage.co', TRUE, 'ALPHA_VANTAGE_API_KEY',  'off',    1, 15, 1, '{"maxRequestsPerRun": 15, "requestsPerMinute": 5}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Keep one seeded description honest: the list endpoint no longer returns
-- three integrations. Text only — the key, method, path, auth kind and action
-- links are untouched, and the endpoint registry in
-- src/lib/admin-access/endpoint-registry.ts carries the same sentence.
-- ---------------------------------------------------------------------------
UPDATE admin_endpoints
   SET description = 'Every integration with its schedule, settings, latest run and whether the scheduler runs in this process. Never returns an API key.'
 WHERE key = 'admin.integrations.list';

COMMIT;
