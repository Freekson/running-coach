# Training calendar (RUN-31)

`/app/calendar` lives in the authenticated app shell and Training navigation.
It supports Monday-based weeks, months, previous/next navigation and Today.
Multiple sessions on one date remain independent stable workout identities.
The page and every move action verify the current session; ADMIN has the same
private-data restrictions as USER.

## Dates and calendar reads

`src/lib/training-calendar.ts` performs date-only arithmetic using UTC as a
calendar arithmetic container. A scheduled date is never interpreted as the
instant a workout starts. The existing `PlanRevisionWorkout.scheduledDate`
PostgreSQL DATE and explicit IANA `timezone` remain authoritative. Profile
timezone changes, travel and DST cannot relocate date-only prescriptions.
The profile timezone determines Today and the default displayed week; missing
or invalid preferences fall back to UTC, which is displayed explicitly.
Calendar navigation accepts years 1900–9998, leaving room for padded weeks and
activity-query margins. The range helper validates this boundary independently
and caps generated weeks/months at 7/42 days. Month-end arithmetic avoids
JavaScript's special treatment of constructor years 0–99.

`src/server/plans/calendar.ts` reads the owner's current approved revisions in
a consistent transaction. It validates stored canonical definitions and maps
planned, completed, missed, canceled, locked and moved states into a small
serializable view. Current-day sessions remain planned until the following
local day. Move labels use revision history and survive subsequent edits to
other sessions. A day with no active prescription or activity is labeled
rest/recovery only inside an approved detail window. Outside that window,
including gaps in the macro strategy, the calendar says no sessions scheduled.
An unlinked activity never implicitly completes a planned session.

Saved Activities use their valid recorded source timezone, falling back to the
profile timezone. Linked activity details appear with their completed workout.
When an activity happened on a different local date, it also appears on its
actual date as a **Linked activity**, including when its prescription is outside
the visible week. Only a same-day representation is deduplicated. Actual linked
activity days therefore cannot become false rest days. The existing activity visibility
policy preserves saved Garmin records after disconnect and excludes unverified
or replaced provider accounts. Calendar rendering and rescheduling call no
external API and require neither provider credentials nor a live connection.

## Explicit session moves

`rescheduleCalendarWorkout(owner, input)` accepts a plan ID, expected current
revision ID, stable workout ID, destination local date and explicit timezone.
The server derives the owner from the verified session. The dialog's
**Approve date change** action is explicit human approval of this single edit.

Moves are limited to future editable sessions within their approved detail
window. The whole current local day is protected because sessions have no
scheduled clock time. Both the original session timezone and the destination
timezone are checked; travel cannot unlock history. Completed, locked and
canceled sessions cannot move. Extending the detail window requires the
existing plan refresh workflow.

The move transaction copies the approved strategy and constraints into an
existing-model source draft, appends a full immutable revision, changes only
the selected membership's date/timezone and advances the current pointer.
Its approved source draft contains only the moved session as the edit proposal.
The revision retains the full membership, including canceled history and all
completed/locked sessions. Historical membership therefore does not consume
the source draft's 200-workout proposal limit, even after repeated refreshes.
Membership rows remain the source of truth for each session's timezone;
the source draft retains the plan-level constraints. Definitions, unrelated
sessions, operational locks and all older approved snapshots stay unchanged.
Refresh preserves each existing identity's session timezone, including unchanged
echoed locked/completed sessions. Only new identities inherit the draft timezone;
explicit calendar moves can change a session's timezone. Future-date validation
uses the resulting session timezone.
The shared `appendApprovedRevision` persistence helper is also used by ordinary
plan approval. There is no parallel planning model or automatic publication.

Serializable transactions and an expected-pointer comparison serialize moves,
completion/locking and plan approvals. A stale request produces conflict
feedback and a reload action. A move to the same date and zone creates no new
revision. Validation, missing resources and unavailable accounts have safe
user-facing messages; database details are never returned.

## Activity link migration and deployment

`20261115140000_run31_calendar_activity_link` adds nullable
`PlannedWorkout.completedActivityId`, an owner-compatible composite foreign
key to Activity, and a unique index allowing an activity to link to only one
workout for its owner. A check requires completion and lock timestamps whenever
a link exists. Existing monotonic lock triggers therefore also protect linked
workouts during refresh. The deferred foreign key permits account deletion
cascades while rejecting cross-owner links. Existing rows remain null; no
backfill or personal-data deletion occurs. Automatic matching/link management
remains RUN-42; this issue supplies persistence and calendar rendering for links.

Apply the additive migration before deploying the new application and generate
Prisma Client. Follow the existing target assertions and runtime grants in
[database operations](database-operations.md). Production retains the standard
backup/PITR assumptions. The column, check, FK and index take ordinary DDL locks;
allow for contention when deploying against a large Activity/workout dataset.
Rollback the application first and retain the additive column and links.

The migration was applied to the marked local Docker development database and
the full migration chain was also applied to a fresh temporary local database.
The temporary database was marked NON_PRODUCTION, its target assertion and new
constraints were verified, and only that temporary database was removed.
The existing Windows engine DLL lock required generating Prisma in a temporary
project output and installing the generated code/types while retaining the
identical pinned engine. No generator configuration change is committed.

## Verification

- Unit tests cover Monday/year/month boundaries, leap dates, both DST changes,
  date-line timezone differences, unsupported year/range bounds and invalid
  date/timezone/owner payloads.
- PostgreSQL integration tests cover independent same-day moves, stale and
  concurrent edits, locks/completion through refresh, older snapshot equality,
  another owner including ADMIN, nested resource mismatches, provider disconnect,
  DST activity dates and SQL link constraints. Regressions cover custom session
  zones through refresh and linked activities performed on another day/week.
  Repeated replacement refreshes exceeding 200 retained memberships are followed
  by a move that preserves every unrelated membership, older snapshot and lock.
  Fixtures are synthetic.
- Page/action tests cover session-derived ownership, unauthenticated and
  unavailable accounts, safe read failures and invalid navigation queries.
- UI tests cover status labels, linked activities, week/month navigation,
  no-plan, sparse, loading, pending, failed and conflict/reload states.
- Feature stories expose these states. Headless Chrome checks exercised week,
  month, no-plan and loading views at 1440, 375, 320 and 640 CSS pixels (the last
  with a 2x device scale for zoom-equivalent reflow), with no horizontal
  overflow. The mobile dialog fits the viewport and closes with Escape.
  Native modal focus behavior, readable status words and semantic dark-theme
  tokens are preserved. No authenticated browser end-to-end test was run;
  database services and client interactions were verified separately.

Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:db`, `pnpm build` and `pnpm build-storybook`. Database test files run
sequentially because parallel suites can conflict through PostgreSQL serializable
predicate locks; concurrency cases within each suite still run competing calls.
