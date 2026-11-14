# Goals and plan drafts (RUN-32)

Goals are managed at `/app/goals`, with authenticated create and edit dialogs at
`/app/goals/new` and `/app/goals/[id]/edit`. The desktop and mobile Training submenu
contains Goals and History. Plans, Workouts, and Races do not yet have implemented
routes; add them in the order Goals → Plans → Workouts → History → Races as those
features ship. All routes reuse the existing app shell and session checks.

## Goal contract

`src/lib/goals.ts` is the shared strict Zod contract. Every write is validated again
by `src/server/goals/goals.ts`. Distances use meters, stored as `Decimal(12,3)`;
target times use optional integer seconds. Calendar dates use `YYYY-MM-DD` and SQL
`date`, without a timezone conversion. There are no fixed race-distance presets.

- Performance and completion require a distance; performance time is optional.
- Volume requires distance and a week/month/year measurement window.
- Consistency requires a run count and measurement window, rather than distance.
- Surface, optional target date, and optional elevation are explicit fields.
- Independent goals can be active or archived. Archive/restore preserves the goal.
- Delete is permanent and requires confirmation. A referenced goal must be archived
  instead of deleted, preserving draft references.

Server actions in the Goals feature authenticate each mutation, derive an issued
owner context from the verified session, validate input, and invalidate the Goals
route tree. List/read/edit/archive/restore/delete always scope by that owner;
ADMIN receives no access to another athlete's goals. Failure messages do not expose
database details. No provider or AI publication occurs here.

## Plan constraints boundary for RUN-37

`src/lib/plan-constraints.ts` exports reusable validation and editable default
values. Weekdays use the existing profile convention: Sunday = 0, Saturday = 6.
Sessions/week must fit within the unique available weekdays. Maximum session
length is optional, in minutes. Start date is optional; timezone is an IANA name.

`src/server/plans/drafts.ts` exposes:

- `getPlanConstraintDefaults(owner)` reads only that athlete's defaults.
- `createPlanDraft(owner, { goalId, constraints? })` checks the selected goal's
  owner. When constraints are omitted, it copies current profile defaults.
- `getPlanDraft(owner, id)` reads that owner's draft and validated constraints.
- `updatePlanDraftConstraints(owner, id, constraints)` edits only that draft.

Each `plan_drafts` row stores its own schedule fields and references a goal through
`(user_id, goal_id) → goals(user_id, id)`. Different drafts may use the same goal
with different schedules. Profile edits do not change existing drafts; draft edits
do not change profiles or goals. There is no approved plan or revision model in
this change. RUN-33 owns that boundary.

For missing profile defaults, the reusable default helper uses three sessions and
all weekdays (or fewer sessions when the saved availability has fewer days).
Inconsistent legacy defaults preserve the saved session count and offer all
weekdays for review. Timezone defaults to UTC; maximum duration and start date
remain unset because the current profile has no duration/start defaults.

RUN-37 owns the user-facing constraints step and draft lifecycle in the Create plan
wizard. It can consume these schemas and services without copying their rules.
Goals has no schedule editor, plan generator, progress calculations, or Create plan
button leading to an unimplemented route.

## Migration and verification

`20261114090000_run32_goals_plan_drafts` adds two empty tables, indexes, bound checks,
and owner-compatible foreign keys. Existing tables and athlete records are not
rewritten. New foreign-key creation briefly locks `users`; schedule deployment
accordingly. Apply migrations before deploying the new application, and rerun
`pnpm db:grant:runtime` to include both tables. Follow the existing environment
assertion and release sequence in `docs/database-operations.md` and CI.

Application rollback can leave these additive tables in place. Do not drop them
once users have saved data; retain them for a forward fix or restore through the
established backup procedure. No backfill is required.

`pnpm test` covers canonical validation, form mapping, goal interactions, access
gates, and navigation. `pnpm test:db` includes
`src/server/goals/goals.integration.test.ts` for real PostgreSQL CRUD, ADMIN and
cross-user denial, forged input/context, independent drafts/defaults, and direct
composite-FK rejection. Run database tests only against an isolated marked
NON_PRODUCTION development/test database. Storybook examples live under
`Training/Goals`, including mobile, empty, create, all types, and save failures.
