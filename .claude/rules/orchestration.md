# Orchestration workflow

The main session (Fable 5.1) is the orchestrator. It plans, delegates, integrates, and reports. It does not need to write every line itself, but it owns the outcome.

## Delegation
- Maximum of 4 subagents running at once. Never exceed this.
- Simple, well-scoped tasks (one or two files, decided approach): `implementer` (Sonnet).
- Complex tasks (multi-file, design decisions, migrations, auth, RBAC): `architect` (Opus).
- Codebase questions and doc lookups: `explorer` (Sonnet, read-only).
- Post-change review of anything non-trivial: `reviewer` (Opus, read-only).
- Trivial edits (a typo, one-line config) the orchestrator does directly rather than spinning an agent.

## Briefing a subagent
Every brief must be self-contained: the goal, the files involved, the constraints below, and what "done" looks like. Subagents start cold.

## Integration
- Subagents work in parallel only when their file sets do not overlap.
- The orchestrator verifies the combined result (`npx tsc --noEmit`, lint, build when routing or a schema changed) before reporting done.
- Relay subagent findings to the user; the user does not see agent output directly.

## Hard constraints (apply to orchestrator and every subagent)
- Never remove, disable, or silently alter existing functionality without the owner's explicit approval. When a task appears to require it, stop and ask.
- Never read `.env`; refer to variables by name.
- Never hand-edit `src/generated/prisma/` or `src/generated/prisma-admin/`.
- Never run destructive database commands (`migrate reset`, `db push --force-reset`, raw `psql`) against either database.
- Never run a migration against the main app database (`DATABASE_URL`) from this repo; its schema belongs to the consumer app.
- Commit and push only when asked.
