-- Constants: unique index on live account type names
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 005_constants_unique_indexes.sql. Re-running is safe: the index is
-- created IF NOT EXISTS.
--
-- Why this file exists
--   The Constants page now edits two more catalogs, account_base_types and
--   account_types. It refuses a duplicate account type name under the same
--   base type — but, as with the other catalogs before 005, only in
--   application code, as a read followed by a write. Two operators saving the
--   same name at the same moment could both pass the read. This index makes
--   the database the last word: the second write fails with a unique
--   violation, which the API renders as 409 conflict.
--
--   The key is (name, base type), not name alone: the seed legitimately has
--   "Other" under Loans ("Other Loan") and "other" under Assets ("Other
--   Assets"). Matching is case-insensitive (lower()) so "chequing" and
--   "Chequing" are the same name, mirroring assertAccountTypeNameFree() in
--   src/lib/constants/repository.ts. coalesce() folds NULL base types into
--   one group, as uq_categories_live_name_per_parent does for parents.
--
-- Before running
--   The data was checked on 2026-09-06: 37 live account types, no two sharing
--   a name under the same base type. If the CREATE INDEX fails with "could
--   not create unique index", find the duplicates with the query in the
--   comment below, fix them on the Constants page, and run the file again.
--   Nothing from a failed run is applied: the file is one transaction.
--
-- What this adds
--   account_types  unique (lower(name), base type) among live rows only — a
--                  partial index, so retired (deleted_at set) rows never block
--                  a name from being reused, exactly like
--                  uq_categories_live_name_per_parent.
--
-- Not added on purpose
--   account_base_types.name: the table already carries a UNIQUE constraint on
--   the exact value (see prisma-admin/schema.prisma, `name String @unique`),
--   so nothing more is needed there. The app additionally refuses a
--   case-insensitive clash before the write; tightening the constraint to
--   lower(name) would mean dropping the existing one, which is a data change
--   this file deliberately does not make.
--   account_types.display_name: it is a label, not a key, and repeats are
--   legitimate.

BEGIN;

-- Duplicates:
--   SELECT lower(name), coalesce(base_type_id, ''), count(*) FROM account_types
--   WHERE deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_types_live_name_per_base_type
  ON account_types (lower(name), coalesce(base_type_id, ''))
  WHERE deleted_at IS NULL;

COMMENT ON INDEX uq_account_types_live_name_per_base_type IS
  'Live account types: one name per base type, case-insensitive. Retired rows are excluded so a name can be reused.';

COMMIT;
