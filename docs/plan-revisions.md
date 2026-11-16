# Macro plans, rolling detail windows and approved revisions (RUN-33)

RUN-33 extends RUN-32's existing owner-scoped `Goal` and `PlanDraft`. There is
one draft/constraints subsystem. Profile scheduling preferences are copied only
when creating an initial draft; subsequent edits and refresh drafts never write
the profile or another draft.

## Persistence and lifecycle

The server-only entry points live in `src/server/plans/` and require an issued
`OwnerContext` from a verified session. No client-provided owner is accepted;
ADMIN has the same private-plan ownership restrictions as USER.

- `createPlanDraft(owner, { goalId, constraints? })` creates `DRAFT`, version 0.
- `getPlanDraft(owner, id)` returns content, state, version, independent
  constraints, plan ID and base revision ID.
- `updatePlanDraftConstraints(owner, id, constraints, expectedVersion)` increments
  the version and resets content/validation to `DRAFT`. The expected version is
  now required; the existing RUN-32 test callers have been updated.
- `saveGeneratedPlan(owner, { draftId, expectedVersion }, content)` validates
  the internal persistence shape and canonical RUN-28 workout definitions,
  stores `GENERATED`, and increments the version. It does not approve anything.
- `validateGeneratedPlan(owner, { draftId, expectedVersion })` checks period,
  window, identity, ownership and history invariants, stores `VALIDATED`, and
  increments the version. It records the goal's update timestamp.
- `approvePlanDraft(owner, { draftId, expectedVersion, expectedRevisionId,
approve: true })` explicitly approves only a validated, unchanged draft.
  Initial approval expects a null revision; refresh expects its exact base ID.
  Approval repeats validation, including current date and workout locks, and
  rejects changes to the goal since validation.

All mutations use serializable transactions. An aborted transaction can retry
up to three times, with every expected version checked again. Committed stale
edits throw `PlanConflictError`; disallowed states throw `PlanStateError`.
Invalid content throws a Zod error or `PlanValidationError`. Missing resources
and another owner's resources both throw `OwnedResourceNotFoundError`.

Approval atomically creates a `TrainingPlan` on first approval, appends a
numbered `PlanRevision`, creates any new stable `PlannedWorkout` identities,
inserts the complete `PlanRevisionWorkout` membership, advances the current
revision pointer, and freezes the source draft as `APPROVED`. Membership writes
are batched. Any failure rolls back the whole transaction. Competing approvals
claim the expected current pointer before inserting revision numbers, so only
one can advance a base revision.

The revision snapshot stores the goal values, copied constraints, macro strategy
and detail-window dates. Membership rows store canonical definitions, local dates,
timezones and explicit cancellation state for that revision. Historical reads
never reconstruct an old plan using mutable current pointers or the current Goal.
Workout completion/lock timestamps are monotonic operational facts on the stable
identity; they do not mutate previous prescriptions.

## Macro period and rolling window

`content.ts` defines the internal version 1 persistence shape:

- Macro start/end dates, strategy, and ordered phases cover the full period
  without gaps or overlap. A specified draft start date must match the macro
  start. A dated goal must be covered through its target date. For an undated
  goal the submitted explicit macro end date defines the horizon.
- The inclusive detail window spans 14 to 28 calendar days inside the macro
  period. Only workouts inside that submitted window are accepted, each with a
  unique UUID and a canonical versioned `WorkoutDefinition`.
- UUIDs are normalized to lowercase before identity, version and duplicate
  comparisons, matching PostgreSQL UUID semantics. Case variants cannot create
  duplicate logical workouts or incorrectly reject references to existing ones.
- The public manual ChatGPT request/response envelope, file size guards,
  request IDs, scheduling/physiological semantic checks and repair prompts
  remain RUN-34/35/36. This persistence boundary does not replace those checks.

`createPlanRefreshDraft(owner, { planId, baseRevisionId })` requires the current
revision of that owner's plan and copies constraints from its approved snapshot,
not from current profile defaults. It reuses `PlanDraft`; it creates no second
plan store. A refresh can extend the detail window and preserve logical workout
UUIDs when rescheduling or changing an editable session.
Existing identities retain their explicitly scheduled session timezone through
refresh; the draft timezone supplies the zone for new identities. RUN-31 calendar
moves explicitly change individual session zones without changing plan-level
constraints. Unchanged protected sessions can be echoed without resetting their
zones, and future-date checks use each resulting session's timezone.

Sessions on or before their own timezone's current local date, completed sessions,
and explicitly locked sessions cannot change date, zone, definition or cancellation
state. Without a session time, the whole current local day is conservatively
protected. Changing the draft timezone cannot unlock an earlier session.
Omitted protected sessions are retained exactly. Omitted editable sessions
inside the replacement window become explicit cancellations; prior sessions
outside that window are retained. New backdated sessions are rejected.
The merged schedule is also checked against the revised macro period. An active
future session retained outside a shortened/moved period blocks validation and
approval until explicitly rescheduled into that period. Cancelled, completed and
past sessions remain auditable even outside the revised horizon.

`lockPlannedWorkout(owner, { planId, expectedRevisionId, workoutId, completed })`
locks an active member of the current approved revision; `completed: true`
also records completion. Locks cannot be cleared or backdated through this
boundary. A lock acquired after validation is rechecked at approval.

`getTrainingPlan(owner, planId)` reads the current revision pointer and metadata.
`listPlanRevisions(owner, planId)` lists immutable revision metadata, newest first.
`getPlanRevision(owner, planId, revisionId)` reads any owned snapshot with its
complete, deterministically ordered workout membership. All check nested plan
ownership, including mismatches between two plans owned by the same user.

## Database enforcement and deployment

One additive migration, `20261115120000_run33_immutable_plans`, extends existing
drafts and adds four tables: training plans, immutable revisions, stable workout
identities and full snapshot membership. It includes lifecycle/version columns,
owner-compatible composite foreign keys, checks and immutability triggers.
The source-draft FK requires the same owner and plan, including two plans sharing
one Goal. Cyclic source, parent, base, pointer and workout references are deferred
to transaction commit, allowing account deletion cascades regardless of trigger
order. All migration DDL is wrapped in one transaction.

Existing drafts default to `DRAFT`, version 0; their constraints are preserved.
There is no athlete-data backfill or deletion. New indexes and FK/trigger changes
take table/catalog locks; deploy migrations before the application and allow for
ordinary DDL lock contention.

The three unpublished local RUN-33 migrations were consolidated before this PR.
The consolidated migration was applied to a fresh temporary local database;
its columns, constraints, indexes, triggers and function definitions were compared
with the existing development schema and matched. Only then were the three
verified local migration ledger entries replaced by the equivalent single entry.
No local application data or schema was dropped. This one-time ledger operation
was restricted to the marked local Docker database and must not be copied into
production deployment scripts. New targets apply the single migration normally.

Database triggers prevent approved revision/membership UPDATE or DELETE and reject
late membership INSERTs after the creating transaction. Approved drafts are read
only; workout identities and existing lock/completion timestamps cannot change.
Owner account deletion can still cascade through all private plan records.
The runtime grants script permits SELECT/INSERT on snapshots and revokes their
UPDATE/DELETE/TRUNCATE privileges. Other new tables use ordinary application
grants. Services enforce ownership; this is not a claim of PostgreSQL RLS.

For marked development, run `pnpm db:assert:development`, `pnpm db:migrate`, then
`pnpm db:grant:runtime`, and regenerate Prisma Client. Production must use the
existing guarded sequence in [database operations](database-operations.md) and
[release operations](release-operations.md), with a verified backup/PITR point.
Do not use `db push`. Roll back application code first and retain the additive
schema and snapshots. Do not drop revisions or clear locks to recover a conflict.
Immutable snapshots intentionally duplicate prior prescriptions; storage grows
with retained history and should be measured before much larger workloads.

The existing Windows engine DLL lock occurred during local client generation.
Client JavaScript/types were generated in a temporary workspace output and
installed while preserving the identical pinned 6.19.0 engine DLL. Temporary
generation files were removed; no generator configuration change is required.

## Scope and handoff

This implementation provides the persistence services for RUN-34/36/37/38.
It adds no UI, import/export endpoint, automatic AI generation, provider API
calls, publication intents or Garmin sync. RUN-41's production approval reader
and publication foreign-key integration remain a separate publishing change;
approval alone does not publish. No credentials or live provider data are needed
for plan persistence.

Changed files:

- `src/server/plans/drafts.ts`, `content.ts`, `revisions.ts`, `transaction.ts`:
  shared draft lifecycle, validation, approval, snapshots, refresh and conflicts.
- `src/server/plans/content.test.ts`, `revisions.integration.test.ts`, `fixtures.ts`:
  synthetic unit and PostgreSQL coverage.
- `src/server/goals/goals.integration.test.ts`: pass the expected draft version
  through the existing RUN-32 assertions.
- `prisma/schema.prisma`, the single RUN-33 migration above, and
  `prisma/scripts/grant-runtime.sql`: storage, constraints, triggers and grants.
- `package.json`: include plan persistence in the guarded `test:db` suite.
- `docs/plan-revisions.md`, `docs/goals-and-plan-drafts.md`: service/deployment
  contract and the transition from mutable drafts to approved revisions.

## Verified acceptance and checks

All five RUN-33 persistence criteria are covered: independent drafts referencing
one Goal, atomic immutable approval, inspectable snapshots with protected history,
refresh using revision/workout IDs, and owner/cross-user nested-association failures.
The 26 unit tests cover malformed canonical content, macro coverage, window
bounds, normalized/duplicate IDs, retained sessions outside revised periods,
history preservation, rescheduling and timezone boundaries.
The 18 PostgreSQL cases cover the lifecycle, profile isolation, stale/conflicting
approvals, late locks/local-date changes, immutable SQL writes, same-owner
wrong-plan references, cross-user/ADMIN failures, forged unauthenticated owners,
uppercase UUIDs and shortened horizons with explicit rescheduling.
Account cascade cleanup was exercised against both existing and fresh databases.

Local results on 2026-11-15:

| Check                                         | Result                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`                           | Passed                                                                                                 |
| `pnpm lint`                                   | Passed                                                                                                 |
| `pnpm typecheck`                              | Passed                                                                                                 |
| `pnpm test --maxWorkers=2`                    | 1,374 passed; 157 guarded DB/live tests skipped                                                        |
| `pnpm test:db --maxWorkers=2`                 | 151 passed on both fresh and preserved local databases, including 18 RUN-33 cases                      |
| `pnpm build`                                  | Passed                                                                                                 |
| `pnpm exec prisma validate`, `pnpm db:status` | Valid schema; all 21 migrations applied                                                                |
| Existing development upgrade                  | Target guard and catalog equivalence verified; local ledger consolidated without dropping data         |
| Fresh isolated local PostgreSQL               | All 21 migrations and runtime grants applied; 151 integration tests passed; temporary database removed |

No production/Neon migration, live provider operation or device verification was
performed. Storybook was not rebuilt because no UI or stories changed. The supplied
ticket text was used; no connected Linear issue/status update was performed.
