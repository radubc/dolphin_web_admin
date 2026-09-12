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
| [constants.md](./constants.md) | the ten shared reference catalogs, what "push to the main database" does and does not do, and the two kinds (categories, financial institutions) the consumer app pulls instead. |
| [customers.md](./customers.md) | the consumer app's users as the admin console sees them, and how an invitation to the customer Cognito pool works end to end. |
| [integrations.md](./integrations.md) | the external providers (TwelveData catalogs and quotes, Bank of Canada rates), the two watch lists, the scheduler, and how the consumer app asks for a quote or a rate. |
| [costs.md](./costs.md) | what AWS is charging, the daily `aws_costs` job that caches it, what each run costs, and the two AWS account settings (Cost Explorer, cost allocation tags) it needs first. |
| [cost-allocation.md](./cost-allocation.md) | cost **per client**: why it can only be an allocated estimate, which services fall in which pool, the drivers and the two invented constants, and the nightly `allocate_costs` run that writes it. |
| [overview.md](./overview.md) | what the dashboard at `/` shows, which read fills each card, the optional `OPS_*` variables that name the AWS resources, and where the operations thresholds turn amber. |
| [sql/README.md](./sql/README.md) | the SQL scripts to run and in what order. |
| [admin-access/README.md](./admin-access/README.md) | the original design note for the RBAC tables (allowlist, roles, actions, audit). |

Conventions the code follows are in `.claude/rules/` (loaded automatically by
the coding agent); these guides explain the *why* and the *how* for people.
