# Sign-in and sessions

The console uses its **own** Cognito user pool, separate from the consumer
app's. Region, pool id, client id and (optionally) the client secret come from
`.env`; `src/lib/auth/config.ts` reads `ADMIN_COGNITO_*` first and falls back
to the `COGNITO_*` and `NEXT_PUBLIC_COGNITO_*` spellings.

## Sign-in

`/login` is a Server Action (`src/app/login/actions.ts`) calling Cognito's
`USER_PASSWORD_AUTH` flow through `src/lib/auth/cognito.ts`. Before Cognito is
asked, two rate limits apply: per client IP (skipped when the IP is unknown,
see below) and per email address (5 attempts per 15 minutes). Wrong password
and unknown user share one message; the server log keeps the distinction.

Cognito requirements on the app client: `ALLOW_USER_PASSWORD_AUTH`,
`ALLOW_REFRESH_TOKEN_AUTH`, token revocation on, and the client secret in
`.env` if the client has one. Users must be **Confirmed** (not "Force change
password") and the pool must not require MFA; neither flow is implemented yet.

## The session

On success five httpOnly cookies are written (`src/lib/auth/session.ts`):

| Cookie | Path | Lifetime | Holds |
| --- | --- | --- | --- |
| `psa_id_token` | `/` | token lifetime minus 60 s | the id token: the credential every check verifies |
| `psa_access_token` | `/` | same | the access token, for future AWS calls |
| `psa_session` | `/` | 30 days | a marker saying a refresh token exists |
| `psa_refresh_token` | `/api/auth` | 30 days | the refresh token |
| `psa_refresh_user` | `/api/auth` | 30 days | the username the refresh SECRET_HASH is computed over |

The `psa_` prefix differs from the consumer app's `ps_` on purpose: browsers do
not separate cookies by port, so on localhost both apps would otherwise
overwrite each other's session.

Every page render verifies the id token's signature, issuer, audience and
expiry against the pool's JWKS (`verifySession`). Nothing trusts the cookie's
presence alone.

## Refresh

The id token lives an hour. When it is gone:

- a **page** navigation is sent by the proxy to `GET /api/auth/refresh?next=…`,
  which spends the refresh cookie and redirects back;
- a **fetch** from a client component gets 401 `token_expired`; `apiFetch`
  calls `POST /api/auth/refresh` once and retries once.

A Cognito outage leaves every cookie in place (503 `auth_unavailable`); only a
verdict from Cognito that the refresh token is dead clears the session.

## Sign-out

The avatar menu submits a real form to `POST /api/auth/logout`, because the
refresh cookie only travels on a navigation to `/api/auth/*`. The route revokes
the refresh token at Cognito and clears all five cookies.

## Authentication is not authorization

A valid token proves who the caller is. Whether they may do anything is
decided afterwards by the allowlist and the access map, see
[access-control.md](./access-control.md). A signed-in person with no
`admin_users` row lands on `/no-access`.

## Client IP and `TRUST_PROXY_HEADERS`

Per-IP limits and the CSRF origin check need the client's address, which Next
only exposes through forwarded headers. Those are believed only when
`TRUST_PROXY_HEADERS=true`, which is correct behind exactly one trusted load
balancer. Unset (as in development) the IP is "unknown" and per-IP limits are
switched off; per-account and per-user limits still apply. Production must set
it.
