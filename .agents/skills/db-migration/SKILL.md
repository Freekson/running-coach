---
name: db-migration
description: Design or review safe Prisma and Neon PostgreSQL schema changes for Running Coach. Use when adding/changing tables, constraints, tenant scoping, indexes, migrations, or data backfills.
---

# Schema migration workflow

1. Read impacted Prisma schema and relevant `docs/architecture-guardrails.md`. Identify personal ownership, child foreign keys, unique constraints, nullable semantics, timestamps/timezones and existing data.
2. Propose backwards-compatible expand/migrate/contract steps for production where destructive change could affect data. Migration and code deploy ordering matter.
3. Generate a checked-in Prisma migration under `prisma/migrations/` and **inspect generated SQL**; avoid `prisma db push` in production. Keep target assertions, role grants, and Prisma-specific SQL in `prisma/scripts/`; the recoverable RUN-70 migration helper is `scripts/migrations/prepare-run70-migrations.mjs`. Use a direct DB URL for migration and pooled configuration for Vercel runtime as supported by pinned Prisma major.
4. Validate user-scoped uniqueness for provider IDs, ownership-compatible foreign keys, indexes supporting actual queries, no accidental cross-tenant relation.
5. For an existing marked development database, run `pnpm db:assert:development` before migration work. For a fresh isolated development/test database, run `pnpm db:migrate` first, then `pnpm db:mark:nonproduction` with the verified Neon endpoint as described in `docs/database-operations.md`; use the assertion before subsequent migrations. Test applying migrations to a fresh isolated test DB and (for data changes) a representative seeded DB; never run these checks against Production. For an already bootstrapped Production database, the guarded release sequence is `pnpm db:assert:production`, `pnpm db:prepare:run70`, `pnpm db:migrate`, `pnpm db:grant:runtime`, then `pnpm db:status` with the migration-only direct role; inspect the actual CI workflow before changing it. Add rollback/recovery notes, backup assumptions and data backfill approach.
6. Verify requests for `USER` A cannot reference B's data; do not assert RLS protects data until transaction-scoped tenant context was proven with Prisma and pooling.
7. Summarize SQL effect, possible locks/data loss, safe deploy order and verification results. Never use production athlete records as test data.
