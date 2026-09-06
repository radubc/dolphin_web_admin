# Penny Squeeze Admin — documentation

Plain-language guides to what the code does and how the pieces fit. Start with
the architecture, then the topic you need.

| Guide | Read it when you want to know… |
| --- | --- |
| [architecture.md](./architecture.md) | how the app is laid out, what runs where, and how a request travels through it. |
| [auth.md](./auth.md) | how sign-in, sessions, refresh and sign-out work against the admin Cognito pool. |
| [access-control.md](./access-control.md) | who may open which page and call which endpoint: the allowlist, roles, actions, the **access map**, and what happens in the background. |
| [api.md](./api.md) | the API contract: envelope, error codes, rate limits, every endpoint. |
| [database.md](./database.md) | the two databases, the Prisma clients, and the workflow for changing the admin schema (SQL in pgAdmin, then `db pull`). |
| [sql/README.md](./sql/README.md) | the SQL scripts to run and in what order. |
| [admin-access/README.md](./admin-access/README.md) | the original design note for the RBAC tables (allowlist, roles, actions, audit). |

Conventions the code follows are in `.claude/rules/` (loaded automatically by
the coding agent); these guides explain the *why* and the *how* for people.
