---
name: db-migration
description: Design or review safe Prisma and Neon PostgreSQL schema changes for Running Coach. Use when adding/changing tables, constraints, tenant scoping, indexes, migrations, or data backfills.
---

# Schema migration workflow

1. Read impacted Prisma schema and relevant `docs/architecture-guardrails.md`. Identify personal ownership, child foreign keys, unique constraints, nullable semantics, timestamps/timezones and existing data.
2. Propose backwards-compatible expand/migrate/contract steps for production where destructive change could affect data. Migration and code deploy ordering matter.
3. Generate a checked-in Prisma migration and **inspect generated SQL**; avoid `prisma db push` in production. Use a direct DB URL for migration and pooled configuration for Vercel runtime as supported by pinned Prisma major.
4. Validate user-scoped uniqueness for provider IDs, ownership-compatible foreign keys, indexes supporting actual queries, no accidental cross-tenant relation.
5. Test applying migrations to a fresh test DB and (for data changes) a representative seeded DB. Add rollback/recovery notes, backup assumptions and data backfill approach.
6. Verify requests for `USER` A cannot reference B's data; do not assert RLS protects data until transaction-scoped tenant context was proven with Prisma and pooling.
7. Summarize SQL effect, possible locks/data loss, safe deploy order and verification results. Never use production athlete records as test data.
