---
name: implement-linear-issue
description: Implement a scoped Running Coach Linear development issue according to acceptance criteria, project architecture, authorization rules, tests, and CI. Use when tasked to write or change application code for RUN-* tickets.
---

# Implement a Running Coach issue

1. Read the requested Linear issue and its acceptance criteria. If direct Linear access is unavailable, use the supplied ticket text and clearly note missing details. Identify dependencies and existing code paths. Only consult design docs relevant to the issue.
2. Write a concise implementation plan for any multi-file/domain change. Keep diff within issue scope; note new architectural decisions before changing shared contracts.
3. Implement server-side behavior and validation first where applicable. Derive the owner from verified auth; authorize nested entity access. Do not hardcode athlete-specific distance/records. Respect immutable approved plans and data provenance.
4. Write unit tests and, for any owned resource or privileged action, negative cross-user and unauthenticated tests. Use synthetic athlete fixtures.
5. Where changing DB schema, follow `db-migration` skill and inspect SQL migration. Where changing provider adapters, preserve canonical domain model and verify capabilities.
6. Execute format/check, lint, typecheck, tests, build as available. Fix real errors rather than disabling rules. If cannot run, state why and exactly what remains unverified.
7. Summarize: acceptance criteria met/not met, files changed, migration actions, tests/commands and results, risks, and suggested PR description. Do not mark a Linear issue Done without verified acceptance.
