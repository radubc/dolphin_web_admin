# Constants

Four reference catalogs that every tenant of the consumer app shares:

| Kind (`[kind]` in the URL) | Table | Sorted by |
| --- | --- | --- |
| `countries` | `countries` | name |
| `currencies` | `currencies` | code |
| `financial_institutions` | `financial_institutions` | name |
| `categories` | `categories` | name |

The **Constants** page (`/constants`) edits them; the API is
`/api/v1/admin/constants/*` (listed in [api.md](./api.md)); the code is
`src/lib/constants/`.

## Source of truth

The **admin database** masters all four. Operators create, edit and retire rows
there and nowhere else. The **main app database** holds the copy the consumer
app reads, and that copy only ever changes through a push.

That means a change is a two-step act on purpose: edit, look at it, then push.
Until the push, a row is marked

- **new** — the main database has no row with this id;
- **changed** — it has one, but at least one pushed field differs;
- **synced** — the two copies match.

Only the pushed fields are compared and written, so anything else the consumer
app owns on those rows keeps its value — the one exception is
`categories.updated_at`, which a push stamps with the current time on every
category it writes. Ids the main database still holds that the admin catalog no
longer has come back as `mainOnlyIds`; they are shown, never touched.

## Push

`POST /api/v1/admin/constants/[kind]/push` with `{ "ids": [...] }`, or `{}` for
the whole catalog. An **empty** `ids` array is refused with a 422
(`Select at least one row to push.`): "nothing selected" never means
"everything".

- **Upsert by id**, inside a single transaction on the main database.
- **Never deletes.** A row over there may be referenced by tenant data
  (accounts, transactions, budgets), so removing it stays a deliberate,
  manual act on the consumer side. Deleting a country, currency or institution
  in the admin catalog leaves the main copy in place, where it then shows up
  under `mainOnlyIds`.
- **Unchanged rows are skipped** rather than rewritten.
- At most 2000 rows per push, dependencies included. The transaction has a 60 s
  budget; new countries, currencies and institutions are inserted with one
  statement per group, while updates and new categories (which must land
  parents first) are one round trip each.
- A write the main database rejects rolls the whole transaction back and comes
  back as a 409 `conflict` (a duplicate, or any other Prisma error) or a 422
  `validation_failed` (a foreign key pointing at a row that is not there),
  naming the row it failed on where the failing row is known.

### Dependencies

Foreign keys in the main database have to hold at commit, so a push writes
what a row points at before the row itself:

- **countries** — the currencies the selected countries reference are pushed
  first (`countries.currency_id` → `currencies.id`);
- **categories** — the ancestors of the selected categories are pushed first,
  and the selection itself is ordered parents before children
  (`categories.parent_id` → `categories.id`).

Those extra writes are reported in `dependencies`, grouped by kind, and only
the ones that were actually missing or stale in the main database are listed —
a dependency that is already in sync is present over there, so the foreign key
holds without touching it. `results` covers the rows of the requested kind, in
the order they were processed; the `created` / `updated` / `unchanged` counts
span both lists.

A category whose `parent_id` points at a row missing from the admin catalog
cannot be pushed; the transaction fails on the foreign key and nothing is
written.

## Delete semantics

| Kind | `DELETE …/[kind]/[id]` does | Refused when |
| --- | --- | --- |
| `countries` | removes the admin row | — |
| `currencies` | removes the admin row | any admin country still points at it |
| `financial_institutions` | removes the admin row | — |
| `categories` | **soft delete**: sets `deleted_at` (and `updated_at`) | the category still has live children |

Retiring a category is a change like any other: it is `changed` until pushed,
and the push carries the `deleted_at` timestamp across so the consumer app
stops offering it while existing tenant references stay valid. Retired
categories stay in the list responses — the page shows and filters them.
Deleting an already-retired category is a no-op, not an error.

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
- Each uniqueness rule is checked by the app before the write **and** enforced
  by a unique index once
  [`docs/sql/005_constants_unique_indexes.sql`](./sql/005_constants_unique_indexes.sql)
  has run, so two operators saving the same value at the same moment cannot
  both succeed: the second gets a 409 `conflict`.

## Audit

A successful push writes one row to `admin_permission_audit_events`:
`action = 'constants_push'`, `target_type = 'catalog'`, `target_id = NULL`,
and `metadata` carrying `target_label` (the catalog's plural name, which the
audit table shows in the Target column), the kind, the number of rows
requested, the created / updated / unchanged counts, and — when there were any
— `dependencies` as a list of `"<kind>: <rows>"` strings. The actor is the
operator's `admin_users.id`.

The write is **best effort**: `target_type = 'catalog'` is only accepted once
[`docs/sql/004_constants.sql`](./sql/004_constants.sql) has run, and a push that
already committed must not turn into a 500 because the audit row was refused.
A refusal is logged as `[constants] audit skipped`.

## Access

Reading needs `can_read_catalogs` or `can_write_catalogs`; creating, editing,
deleting and pushing need `can_write_catalogs`. As always the rule lives in the
admin database (`admin_endpoints`), not in code — see
[access-control.md](./access-control.md). The endpoints are seeded by
`docs/sql/004_constants.sql`; until that file has run they are super-admin only.
