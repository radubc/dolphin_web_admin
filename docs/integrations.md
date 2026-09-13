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
| `bank_of_canada_rates` | Bank of Canada Valet `https://www.bankofcanada.ca/valet` | no | Reads the `FX_RATES_DAILY` group (about 27 currencies, each as CAD per one unit) and writes a rate for **every active currency pair and nothing else** into `admin_exchange_rates`, one row per pair and day. The rest of the document is remembered in process for the day, never stored. | daily 01:30 |
| `iso_mic_markets` | ISO 20022 `https://www.iso20022.org` | no | Downloads the ISO 10383 MIC register (one CSV) and **inserts the markets `markets` does not have yet**, matched on `mic_code`. Existing rows are never changed or removed. New rows land in the Constants sync ledger as *new*. | weekly, Monday 02:30 |
| `alpha_vantage_quotes` | Alpha Vantage `https://www.alphavantage.co` | **yes**: `ALPHA_VANTAGE_API_KEY` | The **fallback** for symbols TwelveData does not serve. Runs inside the `twelvedata_quotes` run, one symbol per request. **Run now** refreshes the symbols it already owns. | off (it is a fallback) |
| `aws_costs` | AWS (Cost Explorer, Budgets, Free Tier) | no — the **ECS task role**, from the SDK's default credential chain | Asks AWS what the account spent per day and service, how that compares with the budget and how much free-tier credit is left, and caches it in `admin_cost_daily` / `admin_cost_snapshots` for the Cost center page. About four Cost Explorer requests a run at $0.01 each. See [costs.md](./costs.md). | daily 09:00 |
| `cognito_directory` | AWS (Cognito, CloudWatch) | no — the **ECS task role**, from the SDK's default credential chain | Pages the customer Cognito pool into `admin_customer_snapshots`, records the difference from the previous snapshot as lifecycle events in `admin_customer_events` (deletions, disablements, confirmations), reads the pool's daily CloudWatch counters into `admin_pool_metrics_daily`, and records the consumer app's own account deletions as `deleted_in_app`. **Free.** Cognito publishes no deletion event and offers no trigger, so the nightly diff is the only way to know. See [customers.md](./customers.md). | daily 02:30 |
| `allocate_costs` | none — it calls nothing | no credential of any kind | Divides each recent month's cached AWS bill over the tenants and writes `admin_tenant_cost_monthly`: four pools (shared capacity, storage, data transfer, Cognito) split by drivers measured in the consumer app's own tables (`usage_daily`, `file_blobs`, `transactions`, `users.last_seen_at`). **Free**, and the only integration that makes no outbound call — it is one because a schedule, a run history and Run now come free from being one. Needs `aws_costs` to have cached the month first. See [cost-allocation.md](./cost-allocation.md). | daily 03:30 |

Times are wall-clock in the integration's timezone (default `America/Toronto`).
Frequency can be daily, weekly (pick the weekday), monthly (pick a day, 1–28)
or off. Off means the integration only runs when someone presses **Run now**,
or when the consumer app asks for something the cache does not have.

Only the base URL, the enabled flag, the schedule and a few settings are
editable; the drawer shows the settings block that belongs to the integration
being edited and nothing else, and every field there is bounded on the server
by `integrationPatchSchema`. Nothing else about an integration is: they are seeded by the SQL and
the code decides what each one does. The base URL must stay on the provider's
own domain (`twelvedata.com`, `bankofcanada.ca`, `iso20022.org`,
`alphavantage.co`, `amazonaws.com`): the quote integrations send an API key
with every call, and an address an operator could point anywhere would be a
way to read that key.

`aws_costs` is the exception to most of the above. Its provider is AWS itself,
so it carries no API key at all — the credential is the ECS task role — and
its base URL is read by nothing, because the AWS SDK builds its own endpoint
(pinned to `us-east-1`: Cost Explorer, Budgets and Free Tier are global
services reached there). Its run counters count **AWS calls** rather than
items, and each run spends real money. Everything about it is in
[costs.md](./costs.md).

`cognito_directory` is the same kind of exception and costs nothing. Its
credential is the task role too, its base URL is likewise read by nothing (the
SDK resolves the Cognito and CloudWatch endpoints from the **pool's** region,
not `us-east-1` — CloudWatch metrics live where they were produced), and its
counters count **parts of the run**: `total` is always 4, `unchanged` is the
accounts the diff found nothing to say about. It is the one integration whose
reason for existing is that the provider forgets: Cognito has no deletion
event and no deletion trigger, so the only way to know an account went away is
to have written down that it used to be there. Everything about it is in
[customers.md](./customers.md).

`allocate_costs` is the furthest from the rest: it is an integration that
**integrates with nothing**. Both its inputs are already in the two databases —
the cost rows `aws_costs` cached, and the consumer app's own usage counters — so
there is no provider, no credential, no charge, and its `base_url` is a
placeholder nothing reads. It is here because a schedule, a run history, a
settings drawer and a Run now button are exactly what a nightly recomputation
needs, and building a second mechanism for one job would be worse. Its provider
is recorded as `aws` only because that is whose bill it divides; the provider
vocabulary has no `internal` value and widening it for this row was not worth
the change. Its counters count **months**: `total` is the months planned,
`failed` the months with no cached bill to divide (the run then says to run
`aws_costs` first, and still writes the months that do have one), and
`unchanged` a month with no completed day yet — a run on the 1st. Everything
about it is in [cost-allocation.md](./cost-allocation.md).

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
- `aws_costs`: `days` (how far back the daily Cost Explorer fetch reaches,
  default 35, **cap 120** — every page of the answer is a charged request,
  every day, and days already fetched stay in the cache), `componentTag` (the
  cost allocation tag the month's split is grouped by, at most 128 characters)
  and `budgetName` (which budget to read when the account has more than one;
  clear it to go back to the first budget AWS returns).
- `allocate_costs`: `months` (how many months each run recomputes, ending with
  the current partial one; default 2, cap 14 — what Cost Explorer keeps) and
  `fixedFloorShare` (the share of the shared-capacity pool every tenant still
  live at the end of the month carries before the remainder is split by
  activity; default 0.005, cap 0.25, and capped again by the allocator at
  `0.5 / eligible tenants` so the floors together never take more than half
  the pool). Both are in the
  drawer's **Allocation** block, and `fixedFloorShare` is entered as the
  fraction it is — 0.005 is half a percent, 0 switches the floor off. Which services belong to
  which pool, and what drives each pool, are deliberately **not** configurable:
  a per-client figure whose method could be changed from a drawer would not be
  comparable with last month's.
- `cognito_directory`: `metricsDays` — how many days of the pool's CloudWatch
  counters each run re-fetches, ending yesterday (default 35, cap 450, which
  is what CloudWatch keeps at a one-day period). The snapshot and the diff are
  deliberately **not** configurable: "read the whole pool" and "compare with
  the previous snapshot" are what the run is, and a knob narrowing either
  would make the event log lie.

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

The watch list is the **only** thing `admin_exchange_rates` holds rows for. An
earlier version also stored each published `X → CAD` series as a rate row of
its own — a database cache, so that a lookup for an unwatched pair could be
derived without a second provider call — and that filled the table with pairs
nobody watches. The document is now remembered in process instead (below), and
`docs/sql/017_currency_pair_history.sql` deletes the rows the old behaviour
left. Clicking a pair on the page opens its **download history**: every rate
stored for it, newest observation day first, with the source and the fetch
time.

**Adding a pair by hand brings six months with it.** Until 2026-09-12 a manual
add inserted the watch row and stopped there, so the pair sat with an empty
"Latest rate" column until that night's run — which is what the owner reported
from stage. The add now ends with one ranged Bank of Canada call for
`today − 182 days → today` (about 125 published business days), recorded as an
inline `on_demand` run so it appears in the runs drawer, and the create
endpoint answers `{ pair, history }`: `history` carries `status`, `days`,
`from`, `to`, `latestDate`, the row counts and whether the pair was stamped
current. The toast repeats it in words — "125 days of history fetched for
USD/CAD, the newest 11 Sep 2026" — or says why there are none.

The same fetch is available for a pair that is already on the list: **Fetch 6
months**, beside Refresh in the download-history drawer, which posts to
`…/currency-pairs/[id]/backfill` and answers in the same shape. Both go through
`backfillPairHistory` in `src/lib/integrations/backfill.ts`, which is
`fetchObservations` + `writeHistoricalRates` from `jobs/rates.ts` with three
rules on top:

- the **watch row is stamped only when the window really reaches the newest day
  the Bank can have published** (`publishedThrough`): then `last_rated_at` is
  set and `last_error` cleared, so the pair counts as current and that night's
  run skips it. A series the Bank discontinued mid-window leaves the row
  untouched, so the run still tries;
- a currency the Bank publishes **no** series for produces no day at all, and
  the pair keeps the "not published" message in `last_error` — the verdict the
  nightly run would have written anyway;
- it **never fails the operation**. A disabled integration, a run that is
  already live (the 409 `beginRun` raises) or a provider error comes back as a
  `history.status` of `unavailable` / `busy` / `failed` with a message, and the
  pair is on the watch list either way; the history can be fetched again from
  the drawer.

An **inactive** pair refuses the backfill with a 409, the same rule the
on-demand lookup follows: switching a pair off is an operator's decision that
no fetch overturns. None of this touches the consumer app's own endpoint —
`GET /api/v1/service/exchange-rates` still goes through `lookup.ts`, unchanged.

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
GET /api/v1/service/exchange-rates?pairs=USD/CAD&date=2026-03-14
GET /api/v1/service/exchange-rates?pairs=USD/CAD&from=2026-01-01&to=2026-03-31
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

Rates have a stop between 1 and 2 — for the undated form; the two dated forms
are described below. One Valet call returns every published series at once, so
the document is kept **in this process** with the instant it was fetched (the
memo in `src/lib/integrations/jobs/rates.ts`); while it is today's, a pair with
no rate of its own is computed from it — a series, its
reciprocal, or the ratio of two — written, and answered without any provider
call. That is what keeps the feature to one Bank of Canada call a day while
`admin_exchange_rates` still only ever gains a row for a pair that was actually
asked for. The memo is per process, so N app instances make up to N calls a day
between them and a restart costs one more; the Valet API is free and needs no
key, so that is a fair trade for not writing 27 rows a day nobody reads. A pair
whose currency the Bank does not publish still fails cleanly as `not_found` and
is **not** added to the watch list.

### Asking for a past date

The rate endpoint takes an optional date, in one of two forms; the quote
endpoint has no equivalent yet.

- **`date=YYYY-MM-DD`** — the rate that was published **on or before** that
  day. The Bank publishes on business days only, so a Sunday, a holiday or a
  day someone typed in has no observation of its own; the answer is then the
  closest earlier one, up to **ten calendar days** back, and the `date` on the
  rate says which day it really is. Past ten days the pair is `not_found`
  rather than a rate from a fortnight away pretending to be the day's.
- **`from=…&to=…`** — every published observation in the window, so `rates`
  holds one entry per pair *and* day, oldest first. `from ≤ to ≤ today` and at
  most **400 days**; a longer window, a `to` in the future or `date` combined
  with `from`/`to` is a 422.

Both are **cache-first**, because `admin_exchange_rates` is the history:

- for `from`/`to`, the table answers on its own when it holds at least one day
  per week of the window, its oldest day is within a week of `from`, and its
  newest day is at least the last day the Bank can have published on or before
  `to` (before 16:30 ET, that is the previous business day — otherwise a
  request for "the last 30 days" would call the Bank every time);
- for `date`, any stored row inside the ten-day window answers, newest first.

When that test fails, **one** ranged Valet call
(`?start_date=…&end_date=…`, one entry per business day) fetches the window for
every pair at once and the days the table did not have are inserted — again,
only for the pairs that were asked for. The call is recorded as an `on_demand`
run like any other. Unlike the "latest" form, a historical answer never falls
back to a rate from **outside** the window: the caller asked what the rate was
on those days, and a value from another day would be a wrong number rather
than a stale one.

Two things a historical write deliberately does **not** do: it does not stamp
`last_rated_at` on the watch row (a rate from 2019 does not make the pair
current, and claiming it would let that night's run skip the pair), and it does
not set `last_error` when the Bank did not publish a currency back then (that
says nothing about the pair today). A pair the request put on the watch list
for the first time is therefore created without a `last_rated_at`, and the
nightly run picks it up.

The operator-facing six-month backfill (above) reuses the same two functions
but *does* stamp the row — because its window ends **today**, so when the
newest published day is among the days written the pair genuinely is current.
That decision lives in `backfill.ts`, not in `writeHistoricalRates`, which is
why the service lookups are unaffected by it.

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
| `admin_exchange_rates` | pair × observation day, **for watched pairs only** |

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
- It does not delete catalog rows, quotes or rates, ever. (The one deletion
  in this feature's history is a hand-run script, not the app:
  `docs/sql/017_currency_pair_history.sql` clears the rate rows the retired
  series cache wrote for pairs that are not on the watch list.)
