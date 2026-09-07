# Integrations

Outbound calls the admin app makes to external providers: the market-data
catalogs, end-of-day quotes and daily exchange rates the consumer app reads.
The **Integrations** page (`/integrations`) shows all of them, lets an
operator change when they run and against which address, and holds the two
watch lists that decide *what* gets quoted. The code is `src/lib/integrations/`;
the API is `/api/v1/admin/integrations/*` plus two API-key endpoints under
`/api/v1/service/*` (all listed in [api.md](./api.md)); the tables are created
by [`docs/sql/008_integrations.sql`](./sql/008_integrations.sql) and
[`009_markets_and_alpha_vantage.sql`](./sql/009_markets_and_alpha_vantage.sql).

This is the port of what the macOS app did for itself: `TWDimportAPIService`
(catalogs), `QuoteService` (quotes), `AlphaVantageQuoteService` (the quote
fallback) and `BankOfCanadaService` (rates). The difference is that the admin
app does it once, for every tenant, and caches the answer in the admin
database.

## The integrations

| Key | Provider | Key needed | What it does | Default schedule |
| --- | --- | --- | --- | --- |
| `twelvedata_catalogs` | TwelveData `https://api.twelvedata.com` | no | Downloads `/stocks`, `/etfs` and `/cryptocurrencies` and **inserts the rows the admin catalogs do not have yet** into `stocks`, `etfs` and `cryptocurrencies`. Existing rows are never changed or removed. New rows land in the Constants sync ledger as *new*, so the Constants page can push them to the main database. | daily 02:00 |
| `twelvedata_quotes` | TwelveData `/quote` | **yes**: `TWELVEDATA_API_KEY` | Fetches the end-of-day quote for every active symbol on the quote watch list and caches it in `admin_quotes`, one row per symbol and trading day. Symbols already fetched today are skipped unless the run is forced. | daily 01:00 |
| `bank_of_canada_rates` | Bank of Canada Valet `https://www.bankofcanada.ca/valet` | no | Reads the `FX_RATES_DAILY` group (about 27 currencies, each as CAD per one unit) and writes a rate for every active currency pair into `admin_exchange_rates`, one row per pair and day. | daily 01:30 |
| `iso_mic_markets` | ISO 20022 `https://www.iso20022.org` | no | Downloads the ISO 10383 MIC register (one CSV) and **inserts the markets `markets` does not have yet**, matched on `mic_code`. Existing rows are never changed or removed. New rows land in the Constants sync ledger as *new*. | weekly, Monday 02:30 |
| `alpha_vantage_quotes` | Alpha Vantage `https://www.alphavantage.co` | **yes**: `ALPHA_VANTAGE_API_KEY` | The **fallback** for symbols TwelveData does not serve. Runs inside the `twelvedata_quotes` run, one symbol per request. **Run now** refreshes the symbols it already owns. | off (it is a fallback) |

Times are wall-clock in the integration's timezone (default `America/Toronto`).
Frequency can be daily, weekly (pick the weekday), monthly (pick a day, 1–28)
or off. Off means the integration only runs when someone presses **Run now**,
or when the consumer app asks for something the cache does not have.

Only the base URL, the enabled flag, the schedule and a few settings are
editable. Nothing else about an integration is: they are seeded by the SQL and
the code decides what each one does. The base URL must stay on the provider's
own domain (`twelvedata.com`, `bankofcanada.ca`, `iso20022.org`,
`alphavantage.co`): the quote integrations send an API key with every call, and
an address an operator could point anywhere would be a way to read that key.

TwelveData's key travels in a request header, never in the URL. Alpha Vantage
accepts its key **only** as the `apikey` query parameter, so that one provider's
URLs really do carry a credential; every message and log line those calls
produce is passed through `redactUrl`, which blanks it, and the domain pin above
is what stops the address being aimed somewhere that would keep it.

### Settings

- `twelvedata_catalogs`: which of the three lists to download.
- `twelvedata_quotes`: `batchSize` (symbols per `/quote` call, up to 120) and
  `creditsPerMinute`. TwelveData charges one credit per symbol; the free plan
  allows 8 credits a minute and 800 a day, and the run paces itself to the
  per-minute figure. With the free plan a watch list of 800 symbols is the
  daily ceiling.
- `bank_of_canada_rates`: nothing yet.
- `iso_mic_markets`: `includeExpired` — whether the register's EXPIRED codes
  are loaded too (default no: only ACTIVE and UPDATED).
- `alpha_vantage_quotes`: `maxRequestsPerRun` (default 15, never above 25) and
  `requestsPerMinute` (5). One symbol is one request.

## The watch lists

**Quote symbols** (`admin_quote_symbols`) — one row per instrument to keep
quoted. `kind` is stock, ETF or crypto; `symbol` is the bare ticker as the
catalog spells it and `exchange` is the catalog's exchange name (null for
crypto). The `canonical` form is what the provider is asked for and what the
consumer app sends: `SYMBOL:EXCHANGE` when there is an exchange (`SHOP:TSX`),
the bare symbol otherwise (`AAPL`, `BTC/USD`). When the symbol exists in the
admin catalog its name and currency are copied over for display.

**Currency pairs** (`admin_currency_pairs`) — one row per `from → to` pair.
The Bank of Canada publishes each currency against CAD only, so a pair with CAD
on one side is read straight from the series (inverted for CAD → X), and a
pair with CAD on neither side is the ratio of the two CAD series and is stored
with `source = derived`. A currency the Bank does not publish (the list is on
the page's rail card) cannot be rated; the pair keeps a `last_error` saying so.

Rows enter either list in two ways, recorded in `source`:

- **manual** — an operator adds it on the page;
- **request** — the consumer app asked for it, the cache had nothing, and the
  provider answered. The row is added only *after* a quote or rate was actually
  saved, so a mistyped ticker never becomes a permanent daily credit spend.
  From then on the daily run keeps it current.

An inactive row is kept but skipped by the runs, and a consumer request for it
is answered from whatever is cached, never by a new fetch: switching a row off
is the operator's decision and a request does not overturn it. Deleting a row
does not delete the quotes or rates already cached for it.

## Markets

The admin `markets` catalog is the list of exchanges and trading venues, and
until this integration existed it was empty: nothing else the app talks to
publishes market identifier codes. ISO 20022 publishes the **ISO 10383 MIC
register** as a single CSV, free and without a key — about 2 900 rows whose
columns are exactly the ones `markets` holds (`mic_code`, `operating_mic`,
`market_name`, `iso_country_code`, `city`).

The download is **insert-only**, on the same terms as the TwelveData catalogs:
a market the catalog already has is never updated and never deleted, whatever
the register now says about it, because tenant data on the consumer side
points at those rows. Matching is on `mic_code` (upper-cased on both sides, so
a row entered by hand in lower case still counts as present). A MIC an operator
retired — soft-deleted — counts as present too and is not inserted again.

Each code carries a status: ACTIVE (about 2 290), UPDATED (about 20, meaning
live and changed at the last release) or EXPIRED (about 560, retired). Both
live states are loaded; EXPIRED only when `includeExpired` is switched on.
Market names are stored exactly as the register publishes them, in upper case:
they have an official spelling and inventing a prettier one would be inventing
data. New rows are marked *new* in the Constants sync ledger, so the Constants
page decides when they reach the main app database.

Weekly rather than daily because the register changes on the order of a few
rows a month; a 600 KB download every night to insert nothing is noise.

## The Alpha Vantage fallback

TwelveData's free plan refuses Canadian and most other non-US listings: a quote
for `SHOP:TSX` comes back as an error, having spent the credit. The macOS app
solved this with Alpha Vantage as a per-symbol fallback, and that is what
`alpha_vantage_quotes` is here.

It is a **fallback, not a schedule**. The `twelvedata_quotes` run calls it for
the symbols TwelveData did not return, inside that same run and counted in that
same run's counters — one run row a day, not two — and the run logs a line
saying how many quotes came from each provider. Its own schedule is seeded
`off`; **Run now** on its card refreshes, up to the cap, the symbols it already
owns plus any active symbol with no quote from today, and never touches
TwelveData.

**The quota is the whole design.** The free tier allows **25 requests a day and
5 a minute**, and `GLOBAL_QUOTE` has no batch form, so one symbol is one
request. Three rules follow:

- a symbol Alpha Vantage cannot resolve is never asked about at all;
- `maxRequestsPerRun` caps a pass, and symbols past the cap keep whatever error
  TwelveData recorded and are picked up the next day;
- a throttle answer stops the pass immediately. Alpha Vantage reports both the
  per-minute limit and the daily quota as HTTP **200** with a `Note` or
  `Information` body, so a run that only checked the status code would burn the
  rest of the day on identical non-answers.

**Routing by memory.** `admin_quote_symbols.provider` records which provider
last served each symbol, and it is shown as a small tag on the quote watch
list. A symbol Alpha Vantage owns skips TwelveData on later runs (saving the
credit *and* the daily miss); one TwelveData owns never spends an Alpha Vantage
request. The column is `NULL` until the first quote is saved and is never
cleared by a failure — the memory is exactly what stops the next run from
paying to be refused again.

**Symbol mapping.** The canonical `SYMBOL:EXCHANGE` becomes Alpha Vantage
notation, or nothing at all:

| Canonical | Alpha Vantage |
| --- | --- |
| a crypto pair (contains `/`) | not mappable — never asked |
| a US exchange: NYSE, NASDAQ, AMEX, NYSE AMERICAN, NYSE ARCA, ARCA, BATS, CBOE, IEX, OTC, OTCQB, OTCQX, OTC MARKETS | the bare ticker (`AAPL`) |
| TSX → TRT, TSXV → TRV, LSE → LON, XETRA/XETR → DEX, FSX/FRA → FRK, BSE → BSE, SSE → SHH, SZSE → SHZ | `TICKER.SUFFIX` (`SHOP.TRT`) |
| any other exchange | not mappable — never asked |
| a bare symbol with no exchange | as it stands |

Alpha Vantage reports **no currency**, so the stored quote takes the watch
row's catalog currency, or `""`. The daily change and its fraction are computed
from `05. price` and `08. previous close`, so they are consistent with the two
prices stored beside them.

## How the consumer app gets a quote or a rate

Two endpoints for machine callers, authenticated with an `API_KEYS` entry
(`x-api-key` header), never a browser session:

```
GET /api/v1/service/quotes?symbols=AAPL,SHOP:TSX,BTC/USD
GET /api/v1/service/exchange-rates?pairs=USD/CAD,EUR/USD
```

Each answers with the newest cached row per item and a `missing` list. The
rule for every item is the same:

1. cached and fetched today → answer from the cache;
2. cached but older, or not cached at all → ask the provider now, save the
   answer, add the item to the watch list if it was not there, answer;
3. provider unreachable, refused, disabled or missing its key → answer the
   newest cached row if there is one (the reply says how old it is), otherwise
   report the item under `missing` with a reason (`not_found`,
   `provider_error`, `unavailable`).

A quote lookup asks TwelveData for at most one batch (`batchSize` symbols)
inside the request, and Alpha Vantage for at most **three** symbols (the whole
day is 25; one consumer call must not be able to spend it). If more symbols are
stale, a background run fetches the rest and those symbols come back from the
cache, or under `missing` with the reason `pending`: ask again in a minute.
Without those caps, a hundred stale symbols on the free plans would hold the
request open for a quarter of an hour.

The endpoints never fail because a provider is down. A provider call made on
behalf of a request is recorded as an `on_demand` run so it shows up in the
run history; answers served from the cache leave no trace.

## Runs and the scheduler

Every execution is a row in `admin_integration_runs`: what triggered it
(`scheduled`, `manual`, `on_demand`), progress, counters (created, updated,
unchanged, failed), outcome and error. The page follows a running run by
polling and shows the last ones per integration. Like the Constants jobs, a
run refreshes a heartbeat while it works; a run whose heartbeat has gone quiet
for five minutes was interrupted by a process restart and is reported as such.
Every batch commits on its own, so starting it again loses nothing. One run per
integration at a time; a second request is refused with 409.

The scheduler is in-process: `src/instrumentation.ts` starts a ticker when the
Node server boots (once per process), and every minute it looks for enabled
integrations whose `next_run_at` has passed. Claiming an integration is an
atomic update of `next_run_at`, so two instances of the app behind a load
balancer never both run it. Set `INTEGRATIONS_SCHEDULER=off` on a process that
must not run anything (a second local dev server, a one-off script); the page
then shows a banner saying nothing starts on its own.

## Environment variables

| Variable | Needed by | Notes |
| --- | --- | --- |
| `TWELVEDATA_API_KEY` | `twelvedata_quotes` and the on-demand quote endpoint | Server-only. The page only ever shows whether it is set. |
| `ALPHA_VANTAGE_API_KEY` | `alpha_vantage_quotes`, the quote fallback | Server-only. Alpha Vantage takes it as a query parameter, so the URLs those calls build are redacted before they reach any log or error. Without it the fallback is simply skipped. |
| `API_KEYS` | the two `/api/v1/service/*` endpoints | Already documented in [api.md](./api.md); the consumer app presents one of these. |
| `INTEGRATIONS_SCHEDULER` | the scheduler | Optional. `off` disables the in-process ticker. |

## Tables

All in the admin database, created by `008_integrations.sql`:

| Table | One row per |
| --- | --- |
| `admin_integrations` | integration (seeded, five rows): address, key requirement, schedule, settings, last/next run |
| `admin_integration_runs` | run |
| `admin_quote_symbols` | instrument on the quote watch list (`provider` says which provider last served it) |
| `admin_quotes` | symbol × trading day |
| `admin_currency_pairs` | currency pair on the rate watch list |
| `admin_exchange_rates` | pair × observation day |

Prices are `NUMERIC(20,8)` and rates `NUMERIC(20,10)`: wider than the macOS
and main-database columns on purpose, so a small-cap crypto price or a rate
above 1 is stored as published.

## What it does not do

- It does not write to the main app database. The catalogs reach the main
  database through the Constants page's push; quotes and rates are served over
  the service endpoints.
- It does not quote crypto through Alpha Vantage. Pairs like `BTC/USD` are a
  different endpoint there, and TwelveData serves them on the free plan.
- It does not update or delete a market once the MIC register has been read
  once. A venue that changed its published name upstream keeps the row the
  catalog already has; the Constants page is where a row is changed by hand.
- It does not delete catalog rows, quotes or rates, ever.
