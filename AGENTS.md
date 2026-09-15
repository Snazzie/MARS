# Repository workflow


## Database migrations

- `packages/db/src/drizzle-schema.ts` is the single source of truth for the PostgreSQL schema.
- Create schema changes with `bun run db:generate` from `packages/db`; do not hand-author numbered migration SQL.
- Run `bun run db:check` before committing generated migrations.
- Apply pending migrations with `bun run db:migrate`.
- Development launch must run `packages/db`'s `db:migrate` script before starting the control plane.
For the meantime, always work directly on `main` and push completed changes to `main`.
