-- Bootstrap the first super-admin for dolphin_web_admin
-- Target database: admin_penny_squeeze (ADMIN_DATABASE_URL)
-- Run AFTER 001 and 002. Idempotent: re-running updates the same row.
--
-- The cognito_sub below is ADMIN_SUB from .env. If your Cognito user's sub or
-- email differ, change them here before running; the sub must be the one the
-- admin user pool reports for your user (Cognito console -> Users -> your user).

INSERT INTO admin_users (cognito_sub, email, display_name, is_super_admin)
VALUES (
  '58012310-5091-7089-060a-0603119e4f4b',
  'radu.barbuta@noseapp.ca',
  'Radu',
  TRUE
)
ON CONFLICT (cognito_sub) DO UPDATE
  SET email          = EXCLUDED.email,
      is_super_admin = TRUE,
      disabled_at    = NULL,
      updated_at     = now();

-- Sanity check: should return one enabled super-admin.
SELECT id, email, is_super_admin, disabled_at, created_at
FROM admin_users
WHERE cognito_sub = '58012310-5091-7089-060a-0603119e4f4b';
