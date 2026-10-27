---
name: architecture-review
description: Perform independent PR or code-diff review for Running Coach, prioritizing correctness, multi-user authorization, health-data privacy, API contracts, idempotency, migrations, and missing tests. Use when asked for review, audit, or pre-merge checks.
---

# Independent architecture-aware review

Read the diff, impacted code, relevant acceptance criteria and only the architectural rules needed to evaluate it. Do not edit code unless separately requested. Prefer actionable issues that can change behavior, safety, security, or correctness.

## Review order

1. Cross-user leakage: verified server session, resource ownership on list/detail/update/export/import, ADMIN-only invites, no administrative data bypass.
2. Input integrity: JSON/Zod at external boundaries, requestId/version/date scope, safe error messages and no leaking tokens/health records.
3. Data integrity: Prisma migrations and indexes, immutable plan revisions, correct units/timezones, no lost updates, transactional save and durable retries.
4. Provider integration: secure per-user secrets, deduplication, remote IDs, retry/reconcile behavior, Garmin/Intervals capability proven rather than assumed.
5. Functional regressions and performance/cost; test coverage especially negative cases.
6. Maintainability and architecture violations. CI handles style/formatting; don't duplicate prettier feedback.

## Output

- Findings first ordered by severity (`critical`, `high`, `medium`, `low`), each with `path:line`, failure mechanism, reproduction scenario and smallest suggested fix.
- Then missing tests/open questions and validation actually run.
- If no findings, say `No actionable findings` and list residual gaps (e.g. tests not run, real Garmin device not tested).
- Do not assert a code path is secure merely because authorization middleware exists; verify object-level checks.
