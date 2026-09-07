# Constants

Ten reference catalogs that every tenant of the consumer app shares: six the
operators curate by hand, and four market-data catalogs that arrive from a
feed. The market-data ones are the big ones — stocks, ETFs and
cryptocurrencies together run to roughly 300 000 rows, loaded once and then
topped up — and everything about paging, the sync ledger and the compare and
push jobs below exists because of that size.

| Kind (`[kind]` in the URL) | Admin table | Main-app table | Id | Sorted by |
| --- | --- | --- | --- | --- |
| `countries` | `countries` | `countries` | UUID | name |
| `currencies` | `currencies` | `currencies` | UUID | code |
| `financial_institutions` | `financial_institutions` | `financial_institutions` | UUID | name |
| `categories` | `categories` | `categories` | UUID | name |
| `account_base_types` | `account_base_types` | `account_base_types` | UUID | name |
| `account_types` | `account_types` | `account_types` | UUID | display name |
| `cryptocurrencies` | `cryptocurrencies` | `preload_cryptocurrencies` | integer | symbol, base, quote |
| `etfs` | `etfs` | `preload_etfs` | integer | symbol, exchange |
| `stocks` | `stocks` | `preload_stocks` | integer | symbol, exchange |
| `markets` | `markets` | `markets` | UUID | MIC code |

The four market-data catalogs do **not** share their name across the two
databases: the main app calls three of them `preload_*`. `MAIN_TABLE_OF` in
`src/lib/constants/types.ts` is the mapping, and it is what the push targets.

The **Constants** page (`/constants`) edits them; the API is
`/api/v1/admin/constants/*` (listed in [api.md](./api.md)); the code is
`src/lib/constants/`.

## Ids

`id` is a **string on the wire for every kind**, but `cryptocurrencies`, `etfs`
and `stocks` are keyed by a Postgres integer sequence rather than a UUID
(`INTEGER_ID_KINDS` / `hasIntegerId()`). Those ids are serialised with
`String(id)` and parsed back by `src/lib/constants/ids.ts`, which is the only
place a wire id becomes a number: it accepts digits with no sign, no leading
zero and nothing past `Number.MAX_SAFE_INTEGER`, and answers anything else with
a 404 `not_found` rather than letting `NaN` into a query. A create never
supplies an id for those kinds — the admin database's sequence assigns it.

## Source of truth

The **admin database** masters all ten. Operators create, edit and retire rows
there and nowhere else. The **main app database** holds the copy the consumer
app reads, and that copy only ever changes through a push.

That means a change is a two-step act on purpose: edit, look at it, then push.
Until the push, a row is marked

- **new** — the main database has no row with this id;
- **changed** — it has one, but at least one pushed field differs;
- **synced** — the two copies match;
- **unknown** — nothing has compared this row yet.

Only the pushed fields are compared and written, so anything else the consumer
app owns on those rows keeps its value — the exceptions are
`categories.updated_at` and `markets.updated_at`, which a push stamps with the
current time on every category and every market it writes.

## The sync ledger

The market-data catalogs run to roughly **300 000 rows** (stocks, ETFs,
cryptocurrencies arrive from a market-data feed: one bulk load, then
increments). Comparing that against the main database on every page load, or
pushing it in one transaction, is not something either database will do. So
the state is **stored**, in `admin_constant_sync`:

| Column | |
| --- | --- |
| `kind` | the catalog, as in the URL |
| `row_id` | the row's primary key **as text**, so one table serves ten kinds |
| `state` | `new`, `changed`, `synced` or `main_only` |
| `compared_at` | when that verdict was reached |

- A **compare job** rebuilds a whole kind (below).
- After that, every create, edit, retirement, delete and push keeps its own
  rows current: a create records `new` (the sequence-keyed kinds compare first,
  because the number may already exist over there), an edit and a retirement
  re-compare that one row, a hard delete forgets it, and a push marks every row
  it wrote `synced`.
- A row with **no ledger entry** reads as `unknown`. That is the honest answer
  before the first compare, and after a bulk load of rows nothing has looked at
  yet.
- `main_only` entries are ids the **main** database has and the admin catalog
  does not. They are never rows in a list response — there is no admin row to
  show — only the `counts.mainOnly` figure.

`src/lib/constants/ledger.ts` is the only writer. A page of states goes in as a
single `INSERT … SELECT FROM unnest($ids, $states) ON CONFLICT DO UPDATE`, in
chunks of 5000, so a compare of 300 000 rows is 60 statements rather than
300 000.

## Compare

`POST /api/v1/admin/constants/[kind]/compare` starts a job that:

1. walks the admin catalog in **primary-key order**, 5000 rows at a time
   (a cursor, not an `OFFSET`, so the last page costs what the first did);
2. reads the matching main rows by id, 1000 per query, and records
   `new` / `changed` / `synced` for the page;
3. then walks the **main** table's ids the same way and records everything the
   admin catalog does not have as `main_only`.

Run it **after a bulk load** from the feed, after anyone has written to either
database outside the console, and whenever the `unknown` count is large enough
to be in the way. Ordinary editing does not need it.

Catalogs of at most 5000 rows are compared **inline**: the response carries an
already finished job. Larger ones answer `running` immediately and are followed
through the jobs endpoints. `counts.lastComparedAt` in a list response is when
the kind's last successful compare finished.

## Jobs

Every compare and every push is a row in `admin_constant_jobs`: what was asked
(`request`), how far it got (`processed` of `total`), what it wrote
(`created`, `updated`, `unchanged`, `dependencyRows`, `mainOnly`), who asked
(`requested_by`), and how it ended.

- `queued` → `running` → `succeeded` | `failed`.
- **Heartbeat.** A running job stamps `heartbeat_at` after every batch **and**
  on a timer every `JOB_HEARTBEAT_INTERVAL_MS` (15 s), so a batch that
  legitimately takes minutes — a 1000-row push transaction — is never mistaken
  for a dead process.
- **`interrupted`** is a derived status, never a stored one. It is what the API
  reports for a job that has gone stale, meaning older than
  `JOB_STALE_AFTER_MS` (5 minutes) measured from `heartbeat_at` (or
  `started_at`) while `running`, or from `created_at` while still `queued` —
  the process that held it was restarted or deployed over. Every batch commits
  on its own, so nothing that was written is lost and nothing has to be rolled
  back: **run it again**. The next job for that kind closes the abandoned row
  as `failed` with `error = "interrupted"`, and that stored form is reported as
  `interrupted` again, so a job never flips from `interrupted` to plain
  `failed`.
- **One compare or push per kind at a time.** A second request while one is in
  flight is a 409 naming the job that holds the catalog. The guard is both
  in-process and a check for a `queued` or `running` row that is not stale, so
  a second app instance is refused too — and a `queued` row left behind by a
  process that died before it started running is cleaned up rather than holding
  the kind forever.
- **Inline or background.** A compare of at most 5000 rows and a push of at
  most 200 rows (`PUSH_INLINE_MAX`) finish before the response is sent, so the
  operator simply sees the result. Anything larger comes back `running` and the
  page polls `GET …/jobs/[jobId]`.
- The runner is in-process: no queue, no worker, no cron. It is what a console
  with a handful of operators needs, and the design survives losing the process
  at any moment.

## Listing, paging and search

`GET /api/v1/admin/constants/[kind]` returns **one page**:
`?page` (1-based), `?pageSize` (default 50, clamped to 200), `?q`, `?state`.
The response carries the rows, `total` (rows matching the query),
whole-catalog `counts`, `lastComparedAt` and `latestJob`.

`?q` is a case-insensitive substring match across the kind's searchable
columns:

| Kind | Searched |
| --- | --- |
| `countries` | name, alpha-2, alpha-3, the currency's code and name |
| `currencies` | code, name, symbol |
| `financial_institutions` | name, institution number, type |
| `categories` | name, type, the parent's name |
| `account_base_types` | name |
| `account_types` | name, display name, the base type's name |
| `cryptocurrencies` | symbol, base, quote, available exchanges |
| `etfs` | symbol, name, exchange, MIC code, country |
| `stocks` | symbol, name, exchange, MIC code, country, type |
| `markets` | MIC, operating MIC, name, country, city |

Every column the table shows as text is searchable. The three that live on
another row — a country's currency, a category's parent, an account type's base
type — are matched through a Prisma relation filter, which Postgres runs as a
subquery on the joined table rather than a second request.

`?state` is `all` (default: every live row), one of the four push states,
`pending` (new + changed) or `retired` (soft-deleted rows, and only for the
three retirable kinds — the others answer an empty page).

The state lives in another table with no relation to the catalogs, which is
what lets one ledger serve ten kinds, so the endpoint takes one of three
routes:

1. **no state filter** — a plain indexed page over the catalog with an exact
   count;
2. **a state, no search** — the *ledger* is paged (`skip`/`take` on
   `(kind, state)`) and the page's ids are read back as rows. Bounded and fast
   at any catalog size. Its `total` is the ledger's count, which can be a
   little high if the ledger still holds an id whose row was deleted straight
   in the database. A compare does **not** clear those: it re-labels the ids
   one of the two databases still has, and an entry for a row neither has is
   left alone — only a delete through the console removes it;
3. **`unknown`, or a state together with a search** — neither table can answer
   alone, so the catalog is scanned. **Without a search** the scan walks *ids
   only*, in batches of 5000, with one ledger lookup per batch, and reads full
   rows for the page's ids at the end. **With a search** it walks whole rows in
   batches of 1000. Memory is one batch plus the page and the count is exact
   either way, but the cost is a **full pass over the catalog per page** —
   about 60 pairs of small round trips for 300 000 rows without a search, and
   one round trip per 1000 matched rows with one, so with a state filter the
   search should be the narrow half. A large `unknown` count is a reason to run
   a compare, which moves the kind back onto route 2.

**Retired rows and the state filters.** Every state filter — `new`, `changed`,
`synced`, `pending`, `unknown` — includes retired rows, which the page marks
with a Retired tag. The ledger describes every row of the catalog, retired ones
included, so hiding them here would make `total` and the rows on the page
disagree. `retired` is the only filter that splits on retirement, and `all`
(the default) is the only one that shows live rows alone.

Deep paging (`?page=5000`) pays Postgres's usual `OFFSET` cost, and `?q` has no
index behind it yet — a trigram index on the market-data catalogs is the
obvious next step if searching 300 000 stocks gets slow.

`counts` is the whole catalog, not the page: `total` (live and retired),
`new` / `changed` / `synced` / `mainOnly` from the ledger, `retired`, and
`unknown` — the rows the ledger says nothing about, computed as
total − (new + changed + synced) and never negative. It is measured against
`total` rather than the live rows because a compare labels retired rows too.

## Push

`POST /api/v1/admin/constants/[kind]/push` with **exactly one** of:

- `{ "ids": ["…"] }` — those rows, whatever state they are in, at most
  `PUSH_IDS_MAX` (5000). An unknown id is a 404 and nothing is pushed. An empty
  array is a 422: "nothing selected" never means "everything".
- `{ "scope": "pending" }` — every row the ledger calls `new` or `changed`.
- `{ "scope": "all" }` — the whole catalog, retired rows included.

Both `ids` and `scope`, or neither, is a 422.

The answer is a **job**. At most `PUSH_INLINE_MAX` (200) rows run inline and
come back `succeeded` or `failed`; more than that comes back `running`.

- **Upsert by id**, in batches of `PUSH_BATCH_SIZE` (1000), **one transaction
  per batch**. That is what makes a 300 000-row push possible at all, and it is
  why an interrupted push is safe: the batches that committed are recorded
  `synced`, and running the push again carries the rest.
- **Never deletes.** A row over there may be referenced by tenant data
  (accounts, transactions, budgets), so removing it stays a deliberate, manual
  act on the consumer side. Deleting a country, currency, institution, account
  base type, cryptocurrency, ETF or stock in the admin catalog leaves the main
  copy in place, where the next compare reports it as `main_only`.
- **Unchanged rows are skipped** rather than rewritten, and still counted.
- **Sequence advance.** A push into `preload_cryptocurrencies`, `preload_etfs`
  or `preload_stocks` keeps the admin id, so it inserts numbers the main
  sequence has never handed out. Each batch that inserted ends, in the same
  transaction, with
  `setval(pg_get_serial_sequence('<table>', 'id'), GREATEST(MAX(id), 1))`, so
  the consumer app's next insert cannot be handed a number this push just took.
  `setval` is **not** transactional: if that batch then rolls back, the
  sequence stays where the call put it. That is harmless — the next `nextval`
  is still above everything in the table — and the only effect is a gap in the
  numbering, which is what sequences allow for.
- **What `processed` counts.** The kind's own rows only, so it can be read
  against `total`. Dependency rows (a currency written for a country, a parent
  category) are counted in `created` / `updated` / `unchanged` and in
  `dependencyRows`, but never in `processed`, which is why those three can add
  up to more than `processed`. On `{ "scope": "pending" }` an id the ledger
  still lists whose catalog row has since been deleted counts as processed:
  it was included in `total`, there is nothing left to push, and the progress
  bar has to reach its end.
- A write the main database rejects rolls **that batch** back and ends the job.
  The message is the same one the old single-transaction push produced — 409
  for a duplicate or any other Prisma error, 422 for a foreign key pointing at
  a row that is not there — naming the row it failed on where that is known.
  Inline, it is the failed job's `error`; in the background, the same. Earlier
  batches stay committed and stay `synced`.

### Dependencies

Foreign keys in the main database have to hold at commit, so a push writes
what a row points at before the row itself, **per batch**:

- **countries** — the currencies the batch's countries reference are pushed
  first (`countries.currency_id` → `currencies.id`);
- **account_types** — the base types the batch references are pushed first
  (`account_types.base_type_id` → `account_base_types.id`);
- **categories** — the ancestors of the batch's categories are pushed first,
  and the batch itself is ordered parents before children
  (`categories.parent_id` → `categories.id`);
- **cryptocurrencies, etfs, stocks, markets** — none. These four reference
  nothing, so they never carry dependencies.

Only dependencies that are actually missing or stale over there are written — a
synced dependency is already present, so the foreign key holds without touching
it — and they are counted as `dependencyRows` on the job. Rows written this way
are recorded `synced` in **their own** kind's ledger.

A category whose `parent_id` points at a row missing from the admin catalog
cannot be pushed; the batch fails on the foreign key. The same holds for an
account type whose `base_type_id` names a base type the admin catalog does not
have.

## Delete semantics

| Kind | `DELETE …/[kind]/[id]` does | Refused when |
| --- | --- | --- |
| `countries` | removes the admin row | — |
| `currencies` | removes the admin row | any admin country still points at it |
| `financial_institutions` | removes the admin row | — |
| `categories` | **soft delete**: sets `deleted_at` (and `updated_at`) | the category still has live children |
| `account_base_types` | removes the admin row | any admin account type — live **or** retired — still points at it |
| `account_types` | **soft delete**: sets `deleted_at` | — |
| `cryptocurrencies` | removes the admin row | — |
| `etfs` | removes the admin row | — |
| `stocks` | removes the admin row | any admin `portfolio_stocks`, `stock_trades` or `watchlist_stocks` row references it |
| `markets` | **soft delete**: sets `deleted_at` (and `updated_at`) | — |

Retiring a category, an account type or a market is a change like any other:
it is `changed` until pushed, and the push carries the `deleted_at` timestamp
across so the consumer app stops offering it while existing tenant references
(accounts and loans, for an account type) stay valid. Retired rows of all three
kinds stay in the list responses — the page shows and filters them. Deleting an
already-retired row is a no-op, not an error.

`stocks` is the one market-data catalog with references **inside the admin
database**: `portfolio_stocks` and `watchlist_stocks` cascade on delete and
`stock_trades` does not, so a hard delete would either take live rows with it or
fail on a foreign key. The delete counts all three and refuses with a 409
instead, naming what still points at the row.

A base type is deleted outright because it has no `deleted_at` column, so the
check counts retired account types too: a row that is only soft-deleted still
carries the foreign key.

## Other rules

- Country `alpha2Code` / `alpha3Code` are stored uppercase and are unique;
  `currencyId` must name an existing admin currency.
- Currency `code` is stored uppercase and is unique, case-insensitively.
- Financial institution names are unique, case-insensitively.
  `institutionNumber` is digits only and is **not** unique: Canadian credit
  unions share institution numbers.
- Category names are unique, case-insensitively, among the live children of one
  parent. A parent must exist, be live, not be the row itself, and not sit
  below it (no loops).
- Account base type names are unique, case-insensitively, across the table (the
  column also carries a plain `UNIQUE` constraint on the exact value).
- Cryptocurrency rows are unique on (`symbol`, `currencyBase`,
  `currencyQuote`), case-insensitively; all three are stored uppercase.
  `availableExchanges` is free text from the feed (up to 2000 characters) and
  may be empty.
- ETF and stock rows are unique on (`symbol`, `exchange`), case-insensitively:
  the same symbol listed on two exchanges is two rows, not a duplicate.
  `symbol`, `currency` and `micCode` are stored uppercase; `exchange`, `name`,
  `country` and a stock's `type` keep the feed's spelling. `figiCode`,
  `cfiCode`, `isin` and `cusip` may be empty and are stored verbatim — the feed
  puts placeholders such as `request_access_via_add_ons` in them, and
  uppercasing would mangle those. A body that omits one of those four is read
  as `""`.
- Market `micCode` and `operatingMic` are exactly four alphanumerics, stored
  uppercase; `isoCountryCode` is exactly two letters, stored uppercase.
  `micCode` is unique across the **whole** table, retired rows included — the
  unique index has no `deleted_at` predicate, so a retired market keeps its
  code reserved and re-listing it means reviving that row.
- Account type `name` is unique, case-insensitively, among the **live** rows
  under the same base type (the seed has "Other" under both Loans and Assets),
  so a retired name can be taken again; `displayName` is a label and is not
  unique. `baseTypeId` must name an existing admin account base type, or be
  null.
- Each uniqueness rule is checked by the app before the write **and** enforced
  by a unique index, so two operators saving the same value at the same moment
  cannot both succeed: the second gets a 409 `conflict`. For the first six
  kinds the indexes come from
  [`docs/sql/005_constants_unique_indexes.sql`](./sql/005_constants_unique_indexes.sql)
  and
  [`docs/sql/006_account_types_unique_index.sql`](./sql/006_account_types_unique_index.sql).
  The four market-data catalogs were **created with** theirs — `cryptocurrencies`
  on (symbol, base, quote), `etfs` and `stocks` on (symbol, exchange),
  `markets` on `mic_code` — so adding them needed **no new SQL file**.

## Audit

A push job writes **one** row to `admin_permission_audit_events` when it
finishes: `action = 'constants_push'`, `target_type = 'catalog'`,
`target_id = NULL`, and `metadata` carrying `target_label` (the catalog's
plural name, which the audit table shows in the Target column), the kind, the
`job_id`, the scope (`pending`, `all`, or `"<n> selected"`), and the
processed / created / updated / unchanged / dependency counts. The actor is the
operator's `admin_users.id`.

The row is written whether the job succeeded or failed — a push that failed on
its fifth batch still wrote four, and the trail has to say so; a failure adds
`failed: true`. The full outcome, including the error message, is on the job.

The write is **best effort**: `target_type = 'catalog'` is only accepted once
[`docs/sql/004_constants.sql`](./sql/004_constants.sql) has run, and a push that
already committed must not turn into a 500 because the audit row was refused.
A refusal is logged as `[constants] audit skipped`.

## Access

Reading — the list, one row, and the job endpoints — needs `can_read_catalogs`
or `can_write_catalogs`; creating, editing, deleting, comparing and pushing
need `can_write_catalogs`. As always the rule lives in the admin database
(`admin_endpoints`), not in code — see
[access-control.md](./access-control.md). The first six endpoints are seeded by
[`docs/sql/004_constants.sql`](./sql/004_constants.sql) and the compare and
jobs endpoints by
[`docs/sql/007_constants_sync_and_jobs.sql`](./sql/007_constants_sync_and_jobs.sql);
until each file has run, its endpoints are super-admin only.

## Schema

The ledger and the job table come from
[`docs/sql/007_constants_sync_and_jobs.sql`](./sql/007_constants_sync_and_jobs.sql),
which the owner runs by hand in pgAdmin. **Until it has run**, the Constants
list, compare, push and job endpoints answer 503 `admin_schema_missing` — the
missing-table error is deliberately not swallowed anywhere in
`src/lib/constants/`, so the console says what is wrong instead of pretending
every row is `unknown`.
