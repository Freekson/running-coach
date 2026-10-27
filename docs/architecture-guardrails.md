# Architecture Guardrails (MVP)

Architecture documents in Linear: [System Architecture](https://linear.app/fr-running-coach/document/running-coach-system-architecture-v02-5856fc20bd24), [Database Design](https://linear.app/fr-running-coach/document/running-coach-database-design-v02-ffb40a1b28b3), [JSON Contract](https://linear.app/fr-running-coach/document/running-coach-json-contract-design-v01-e6d5a33816b4), [PRD](https://linear.app/fr-running-coach/document/running-coach-product-requirements-prd-v05-a336516f50b0).

Use one Next.js App Router application deployed to Vercel with Neon + Prisma. No always-on service for MVP. Domain-first `src/server/{auth,authorization,athlete,activities,goals,plans,workouts,integrations,jobs,notifications,files}/` is the target; adopt incrementally, not empty directories.

## Trust boundaries

1. Browser -> server: verify auth and owner on every request; never trust submitted `userId`.
2. API credentials: encrypted at rest, server-only, no client display. External secrets never in AI JSON export.
3. External responses/files: validate schema, units, version and edit scope before save. Preview/explicit approval precedes publication.
4. Owner-controlled resources: activities, health metrics, goals, plans, workouts, devices, subscriptions and provider connections. Database constraints reinforce the authorization layer.
5. Sync: external IDs scoped to user/provider; recover from duplicate/reordered responses; no network API calls inside long DB transactions.
6. Completed workouts and approved revisions must remain immutable and auditable.
7. ADMIN permissions cover invitations and operations only, not unrelated athlete-private content.

## When changing specific areas

- Auth/schema: review ownership and cross-user tests; migration-safe deploy order.
- AI exchange/workout model: consult JSON Contract; use schemaVersion/requestId, full validation and diff.
- Integrations: prove actual provider features and device mapping; never claim watch delivery from an HTTP 200 to Intervals.icu.
- UI: expose empty/missing data gracefully, keep quiet contextual reminders, prioritize straightforward workflow.
