# Two-factor authentication — admin console plan

**Status: plan only, awaiting the owner's approval (2026-10-04). Nothing built.**

Mirrors phases 1 and 2 of the web app's `docs/two-factor-plan.md`
(`~/Developer/projects/penny-squeeze-web`), plus the customer-support action
briefed in that repo's `docs/admin-console/two-factor-reset.md`. The web
app's designs are reused where the two apps are the same; differences are
called out.

## Where the console stands (inventory, 2026-10-04)

Exists and works: password + authenticator-code sign-in
(`src/lib/auth/cognito.ts`, `src/app/login/actions.ts`), passkey sign-in
(`USER_AUTH` / `WEB_AUTHN`), the Account & security drawer with TOTP
enrolment (text key only), passkey register / list / delete
(`src/lib/account/service.ts`, `src/components/account/`), rate-limit presets
(`src/lib/security/rate-limit.ts`), the customer detail drawer with a
"Cognito account" section (`src/components/customers/customer-detail-drawer.tsx`),
admin calls on the customer pool (`src/lib/customers/cognito.ts`, IAM policy
`customer-user-pool` in `infra/service-admin.yaml`), the audit table
`admin_permission_audit_events`, and the numbered-SQL schema workflow
(`docs/database.md`; next file `021_…`).

Absent: any `WebAuthnMfaSettings` call or `WEB_AUTHN_MFA` reading, a QR
code, recovery codes, a customer "turn off two-factor" action, knowledge of
how the operator's own session was authenticated, tests.

**Live risk today.** Both pools were switched to
`FactorConfiguration: MULTI_FACTOR_WITH_USER_VERIFICATION` on 2026-10-04
(see the web repo's `docs/cognito/README.md`). Without the per-user flag,
an operator who turns on the authenticator app is refused passkey sign-in
(AWS rule, confirmed on stage for the web app). Interim fix per operator,
from the web runbook: `admin-set-user-mfa-preference` with both
`--software-token-mfa-settings Enabled=true,PreferredMfa=true` and
`--web-authn-mfa-settings Enabled=true`. Phase A removes the need for it.

## Phase A — Passkeys count as two factors for operators (small)

Port of the web app's phase 1, same shape, same lessons:

1. `src/lib/account/service.ts`: `setPasskeyMfaPreference(accessToken,
   enabled)` → `SetUserMFAPreference` with `WebAuthnMfaSettings { Enabled }`
   **and**, when enabling, `SoftwareTokenMfaSettings { Enabled: true,
   PreferredMfa: true }` in the same request — Cognito refuses the WebAuthn
   setting alone with "WebAuthn MFA requires enabling an additional MFA
   setting" even when TOTP is already on (stage, 2026-10-03).
   `disableTotp` sends both settings off in one call, falling back to the
   TOTP-only call on refusal (web: `disableSoftwareTokenAndPasskeyMfa`).
2. `ensurePasskeyMfa(accessToken)` (new `src/lib/account/passkey-mfa.ts`,
   best-effort, never throws): when TOTP is on, ≥ 1 passkey exists and
   `UserMFASettingList` lacks `WEB_AUTHN_MFA`, set the flag. Called after
   `verifyTotpEnrolment`, after `completePasskeyRegistration`, and in
   `verifyMfaCode` after the code is accepted and before `createSession`
   (this is what heals operators who enrolled before the change). The
   status read stays a read.
3. `getMfaStatus` / `GET /api/v1/admin/me/mfa` gain `passkeyMfaEnabled`
   (`WEB_AUTHN_MFA` in the list; `types.ts` methods union extended) and
   `passkeySignInPaused` (TOTP on, passkeys exist, flag off).
4. Drawer copy: one sentence explaining the model under the two-factor
   heading; a warning `Alert` while `passkeySignInPaused` ("Passkey sign-in
   is paused while two-factor authentication is on. Until an upcoming update,
   sign in with your password and authenticator code.").
5. Stale comments corrected (all say the pool is `OFF` / `LITE` / no relying
   party): `src/lib/account/service.ts:13–19`,
   `src/components/account/two-factor-section.tsx:15–18`,
   `src/components/account/passkeys-section.tsx:19–21`,
   `src/app/api/v1/admin/me/mfa/totp/route.ts:13–15`,
   `.../passkeys/route.ts:13–15`, `src/lib/auth/cognito.ts:67–69` and
   `:1219–1220`, `docs/api.md:77,80`, `docs/sql/018_…:34–37`; `docs/auth.md`
   gets the real passkey/TOTP rule and a "Passkey MFA" subsection.
6. **Owner decision:** the TOTP issuer label is still `"Penny Squeeze Admin"`
   (`src/lib/account/service.ts:50`); change to `"FairSums Admin"`? Only
   new enrolments are affected.

No SQL, no IAM, no pool change. Test on stage with the operator account:
TOTP on + passkey → both sign-ins work; TOTP off → list empty, passkey
still works.

## Phase B — QR code and operator recovery codes (medium)

Port of the web app's phase 2; the design is `docs/recovery-codes.md` in
the web repo and is not repeated here — only the admin differences:

1. **QR code** in the enrolment step of `two-factor-section.tsx` (antd
   `QRCode` from the existing `otpauth://` URI), text key kept.
2. **Table** `admin_user_recovery_codes` (`user_id` → `admin_users.id`,
   uuid, ON DELETE CASCADE; `code_hash`, `created_at`, `used_at`; unique
   `(user_id, code_hash)`; no RLS, like the other admin tables) as
   `docs/sql/021_admin_user_recovery_codes.sql`; owner runs it on the local
   and stage admin databases, then `npx prisma db pull --config
   prisma-admin.config.ts && npx prisma generate`.
3. **Codes**: ten, shown once after `verifyTotpEnrolment` (PUT
   `/api/v1/admin/me/mfa/totp` returns them), Copy / Download; "N of 10
   left" row; "Generate new codes" behind the password (the console has no
   `verifyPasswordForSensitiveAction` yet — add it to `src/lib/auth/cognito.ts`
   as the web app has, a bare `USER_PASSWORD_AUTH` whose `SOFTWARE_TOKEN_MFA`
   challenge counts as proof). Endpoints registered by the same SQL file
   (`admin.me.recovery_codes.*`, Access Map not needed: `admin.me.*`).
4. **Redeem at sign-in**: "Use a recovery code instead" on the code step →
   `redeemRecoveryCode` server action: email + password + code in one
   request; claim the row atomically (`updateMany … used_at: null`), then
   `AdminSetUserMFAPreference` both settings off **on the admin pool**, undo
   the claim on refusal, delete the other rows, sign in with the password,
   `redirect("/")`; fallback `/login?recovery=used`. IAM: the admin task role
   needs `cognito-idp:AdminSetUserMFAPreference` on the **admin** pool ARN —
   add it to whichever policy already grants `AdminCreateUser` on that pool
   for operator invitations (verify in `infra/service-admin.yaml`).
5. **Rate limits**: add `authMfa` (10 / 15 min) and `accountMfa` presets
   as in the web app; the existing budgets stay (nothing removed). Recovery
   and authenticator codes share the `mfa:email:` key.
6. Shell nudge until re-enrolled, same rule as the web app (TOTP off and
   rows exist; `used_at` set → recovery, unused rows → support reset).

## Phase C — Customer support: "Turn off two-factor authentication" (medium)

The brief `docs/admin-console/two-factor-reset.md` (web repo), made concrete:

1. **Read**: `getCustomer` adds a `twoFactor` block from a direct
   `AdminGetUser` on the customer pool (`UserMFASettingList`,
   `PreferredMfaSetting`), shown in the drawer's "Cognito account" section
   as "Two-factor authentication: On (authenticator, passkey) / Off". The
   cached `ListUsers` directory does not carry it.
2. **Action**: button "Turn off two-factor authentication" → confirm dialog
   with the customer's email typed back → `POST
   /api/v1/admin/customers/[id]/two-factor/reset` →
   `AdminSetUserMFAPreference` on the customer pool with
   `SoftwareTokenMfaSettings { Enabled: false, PreferredMfa: false }` and
   `WebAuthnMfaSettings { Enabled: false }`. It never touches the web app's
   `user_recovery_codes` (the console never reads that database); the
   customer re-enrols in FairSums and gets new codes.
3. **Guards**: endpoint key `admin.customers.two_factor_reset` in the
   registry + Access Map grant (`docs/sql/022_…` or the same file as B2);
   audit row `admin_permission_audit_events` with
   `target_type: "customer_two_factor_reset"` (union in
   `src/lib/admin-access/types.ts`), best-effort as `invites.ts` does;
   rate limit 5 / hour per operator; **the operator must be signed in with
   a second factor**: record the sign-in method in the session at
   `createSession` (`"password"`, `"password+totp"`, `"passkey"`) and
   refuse the action for `"password"` with "Sign in with your authenticator
   app or a passkey to use this." (chosen over the `amr` claim, which the
   pool is not known to emit).
4. **IAM**: `cognito-idp:AdminSetUserMFAPreference` added to the
   `customer-user-pool` policy (`infra/service-admin.yaml`, Sid
   `CustomerPoolOnly`); `docs/customers.md:398–401` updated (it currently
   says the policy grants nothing beyond the four actions).
5. **Email to the customer** is phase 3 of the web plan; not sent here.

## Phase D — Tests and docs (small)

- Unit tests with a mocked Cognito client for the new server paths (the
  console has no test runner today; add the same minimal `node --test` /
  vitest setup the web app uses — check which — rather than a new
  framework).
- `docs/auth.md`, `docs/access-control.md` (step-up rule for the customer
  action), `docs/api.md`, `docs/customers.md`, `CLAUDE.md` line 24.

## Order, effort, owner steps

| # | Phase | Size | Owner steps |
|---|---|---|---|
| A | Passkeys count as two factors | small | deploy; stage test; decide the issuer label |
| C | Customer two-factor reset | medium | run SQL for the endpoint grant; deploy (IAM) |
| B | QR code + operator recovery codes | medium | run SQL 021; `prisma db pull` (admin config); deploy (IAM) |
| D | Tests and docs | small | — |

A first (it closes the live lockout). C before B because it is the support
path the web app's recovery codes assume exists. Phases 3–7 of the web plan
(re-authentication, security emails, two-step sign-in, require-2FA, device
remembering, risk-based) are not planned for the console yet; the
"operator must use a second factor" guard in C is the one step-up rule it
gets now.
