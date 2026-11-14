# Goals and plan drafts (RUN-32)

Goals are managed at `/app/goals`, with local create and edit dialogs. Direct links
at `/app/goals/new` and `/app/goals/[id]/edit` remain authenticated. The desktop and mobile Training submenu
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
- Surface and optional target date are explicit fields. New goals have no elevation
  input. Existing elevation targets are preserved and can be edited on active goals.
- Independent goals can be active or archived. Archive/restore preserves the goal.
- Delete is permanent and requires confirmation. A referenced goal must be archived
  instead of deleted, preserving draft references.

Server actions in the Goals feature authenticate each mutation, derive an issued
owner context from the verified session, validate input, and return the saved goal
with recalculated progress. The client inserts/replaces/removes only that record;
actions do not invalidate the route or trigger a list reload. Opening/cancelling
dialogs never navigates, refreshes the router or calls a mutation. Closing a direct
dialog link replaces the URL using native history, without a server request.
RSC lists use an owner-bound PostgreSQL snapshot and a database-clock observation
time, loaded with the goals and activities in one repeatable-read transaction.
Mutation actions return the changed record (or a deletion marker) plus the committed
transaction's ID and read snapshot. Those receipts are generated inside the same
serializable transaction as the write; a receipt failure rolls the write back.
Serialization conflicts retry at most five times with bounded backoff.

The client retains confirmed local changes separately until a list's snapshot
actually sees their commits. This includes deletion markers, so delayed lists
cannot resurrect a deleted goal. If a list already sees a mutation, a late action
response cannot replace its newer progress. Older lists and older mutation replies
are ignored; later remote edits/deletions are accepted once their snapshots include
the confirmed write. Records merge by ID without duplicate cards or remounting the
screen. Owner changes clear local changes and reject late receipts from the previous owner.

The visibility rule follows PostgreSQL's
[transaction ID and snapshot functions](https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-PG-SNAPSHOT):
the 64-bit ID must be below the snapshot's upper bound and absent from its active
transaction list. These strings avoid JavaScript number precision loss and do not
depend on browser clocks, response arrival order or Vercel instance clocks. The
database observation time orders reads with identical visibility (for calendar
progress changes). Existing flat CRUD service return values remain compatible;
only the authenticated page/action read model carries the synchronization metadata.
List/read/edit/archive/restore/delete always scope by that owner;
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
Goals has no schedule editor, plan generator, or Create plan
button leading to an unimplemented route.

## Progress tracking (RUN-45)

The Goals page loads owner-scoped progress from recorded running activities. The
Active tab includes overdue goals with a separate warning badge. Achieved and
Archived have their own tabs. Archive takes precedence over calculated achievement;
achievement takes precedence over overdue. Delete, archive/restore and edit remain
in the card footer. Tabs support Arrow keys, Home and End.

Active badges are blue, Achieved green, Overdue amber and Archived gray, using shared
semantic tokens. Achieved/completed and archived goals have disabled Edit actions.
Direct edit routes and server mutations enforce the same rule. Save, archive and delete
return the changed goal and progress inside a serializable transaction; failed
progress reads roll back the write. Active goals become editable again after
restore, provided their current activities do not establish achievement.

Each card shows its actual metric, measurement dates and calculation timezone.
There is no expandable calculation section. A target date also shows calendar days left,
"Due today", or days overdue, using the saved profile timezone (UTC fallback).
Calculations are read-only: they never change goals, activities or plan drafts.

- Performance uses the fastest **elapsed** time for a complete recorded run covering
  the entire target distance and no more than 1% extra. Shorter runs never qualify.
  It does not estimate splits or scale pace
  from longer runs. Without a target time, it shows the best result and remains
  active. Missing elapsed time is not replaced with moving or timer time.
- Completion requires a single run covering at least the target distance. An
  optional elevation target must be met by that same run.
- Volume sums recorded distances. If an elevation target exists, both aggregate
  targets must be met; the progress bar uses the lower completion ratio.
- Consistency counts recorded running sessions, including sessions without a
  recorded distance. The percentage is capped at 100%; actual totals remain visible.
- Volume and consistency use the current calendar week (Monday start), month or
  year in the athlete timezone. They reset each period while the deadline remains
  in the future, or indefinitely when no deadline is set. Once a deadline passes,
  the final calendar period ending on that date is used. Performance and completion
  consider all recorded history through today or the earlier deadline.
- Deadlines include the entire local day. Future activities, non-running sports,
  unresolved duplicate candidates, and replaced/unverified Garmin accounts are
  excluded using the existing owner/account visibility boundary.
- Explicit canonical surfaces are validated and persisted on import. Unambiguous
  recorded Garmin subtypes (`trail_running`, `track_running`, `street_running`,
  `treadmill_running`) establish a surface for both new imports and legacy rows.
  Generic running and unknown surfaces do not qualify for surface-specific goals;
  affected cards show the number of excluded runs. No road/trail assumption is made
  from an activity title, pace or generic running sport type.
  Enriching or correcting the surface alone preserves verified FIT laps, their IDs
  and metrics, and the FIT freshness/state. Changes to verified activity identity
  such as distance still invalidate stale laps through the existing import rules.
- Periodic-only lists restrict the activity query to the earliest required calendar
  start and latest deadline. Performance/completion can require full history.
  Activity local dates are prepared once with a reused formatter across all goals.
  Percentages use integer stored units before division to avoid floating-point
  undercounts such as 29 km / 100 km incorrectly displaying 28%.

Achievement is derived from current goal settings and eligible activity data, not
a persisted milestone. Editing a goal, resolving duplicates, switching accounts or
crossing a calendar boundary can change it. Approved-plan/workout models are not
available yet (RUN-33); plan coverage is explicitly unavailable. Drafts and planned
sessions never count as completed runs. No schema migration is needed for RUN-45.

`src/server/goals/progress.test.ts` covers calculations, time boundaries, missing
metrics, owner/account query scopes and forged contexts. The existing Goals DB
suite also covers real activity aggregation for two owners (including ADMIN),
date/sport/account filtering and duplicate exclusion. UI tests cover all four
metrics, status tabs and keyboard navigation, countdowns and footer controls.
Storybook includes all types/statuses, due today, missing progress, empty states,
mobile and mutation failures using synthetic data.

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
