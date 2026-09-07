-- Constants: unique indexes for the reference catalogs
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 004_constants.sql. Re-running is safe: every index is created
-- IF NOT EXISTS.
--
-- Why this file exists
--   The Constants page refuses a duplicate currency code, country code,
--   institution name, or category name under the same parent — but until now
--   only in application code, as a read followed by a write. Two operators
--   saving the same value at the same moment could both pass the read. These
--   indexes make the database the last word: the second write fails with a
--   unique violation, which the API renders as 409 conflict.
--
--   Matching is case-insensitive (lower()/upper()) so "cad" and "CAD" are the
--   same code, mirroring the checks in src/lib/constants/repository.ts.
--
-- Before running
--   The data was checked for duplicates on 2026-09-06 and had none. If a
--   CREATE INDEX fails with "could not create unique index", find the
--   duplicates with the query in the comment above that index, fix them on
--   the Constants page, and run the file again. Nothing from a failed run is
--   applied: the file is one transaction.
--
-- What this adds
--   currencies              unique upper(code)
--   countries               unique upper(alpha2_code), unique upper(alpha3_code)
--   financial_institutions  unique lower(name)
--   categories              unique (lower(name), parent) among live rows only,
--                           where a NULL parent counts as one parent — a
--                           partial index, so retired (deleted_at set) rows
--                           never block a name from being reused.
--
-- Not added on purpose
--   financial_institutions.institution_number: Canadian credit unions share
--   numbers (828, 829, 839 …), so it must stay non-unique.

BEGIN;

-- Duplicates: SELECT upper(code), count(*) FROM currencies GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_currencies_code
  ON currencies (upper(code));

-- Duplicates: SELECT upper(alpha2_code), count(*) FROM countries GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_countries_alpha2_code
  ON countries (upper(alpha2_code));

-- Duplicates: SELECT upper(alpha3_code), count(*) FROM countries GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_countries_alpha3_code
  ON countries (upper(alpha3_code));

-- Duplicates: SELECT lower(name), count(*) FROM financial_institutions GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_institutions_name
  ON financial_institutions (lower(name));

-- Duplicates:
--   SELECT lower(name), coalesce(parent_id, ''), count(*) FROM categories
--   WHERE deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- coalesce() folds NULL parents together: a plain unique index treats every
-- NULL as distinct and would let two top-level "Groceries" rows through.
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_live_name_per_parent
  ON categories (lower(name), coalesce(parent_id, ''))
  WHERE deleted_at IS NULL;

COMMENT ON INDEX uq_categories_live_name_per_parent IS
  'Live categories: one name per parent, case-insensitive. Retired rows are excluded so a name can be reused.';

COMMIT;
