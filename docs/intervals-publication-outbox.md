# RUN-41: explicit workout publication outbox

Issue: [RUN-41](https://linear.app/fr-running-coach/issue/RUN-41/implement-idempotent-intervalsicu-workout-publication-outbox).

## Scope and integration boundary

RUN-38 now connects this durable outbox to RUN-33's persisted approved revisions
through `src/server/plans/publication.ts`. It provides the production approval
reader, a local diff preview and separately confirmed per-workout publication
actions. [Plan refresh](plan-refresh.md) describes the current UI and verification.
Historical verification notes below describe the earlier foundation boundary;
they do not establish live provider or Garmin device delivery.

From the current approved plan's history page, choose **Review Intervals.icu
changes** to read saved per-workout statuses and preview pending operations.
The saved-status list includes settled publications that no longer appear in the
pending diff, and survives reopening the page. Workouts with no receipt explicitly
show local approval or local cancellation only. Queued, running, published, failed,
uncertain, superseded and cancelled receipts remain distinct. Expired running
leases appear uncertain in both the saved list and pending diff.

The displayed date is the current approved local date. A receipt from an earlier
revision is labeled as such; it cannot confirm publication of the new revision.
Reading these statuses never contacts Intervals.icu, queues work or retries a write.
The owner must separately confirm each send/recovery operation. No polling, Cron,
automatic drain or Garmin sync is started. Provider credential/account bindings
remain server-only and are excluded from this owner-scoped DTO.

`createIntervalsPublicationService(readApproved)` requires a server-only
`ApprovedWorkoutReader`. `readApprovedPlanWorkout` implements it against the plan
store using the supplied Prisma transaction and verified owner context. It must:

- Check owner on the plan, revision and logical workout, including nested links.
- Read the **current, explicitly approved**, immutable revision and lock its
  current-revision pointer until the transaction commits. Never construct the
  result from an AI import, request body or client approval flag.
- Return the canonical WorkoutDefinition, stable workout UUID, revision UUID,
  floating local date/IANA zone, and whether the session is locked or cancelled.
  Past/completed sessions must be locked. Retain cancellation tombstones in new
  approved revisions so cancellation never requires deleting approved history.
- Perform only local database work. The outbox never calls a provider inside a
  database transaction and never writes the approved plan store.

The reader is dependency-injected for this boundary, not a substitute approval
store. Foundation tests supply synthetic approved snapshots. RUN-38 additionally
tests the persisted reader and explicitly confirmed create/cancel operations
against the local HTTP provider fixture. Composite plan/revision/workout ownership
is enforced by RUN-33's foreign keys. Publication intent remains a separate store.

RUN-31/38 integration previews the resulting provider changes and nested
repeat expansion before an explicit Publish/Update/Reschedule/Cancel action.
Approval, import, page visits and provider connection must never call `queue`
or `dispatch`. The server actions authenticate, issue an owner context,
validate a small request, and delegate; Next.js enforces same-origin writes. Configure a
sufficient request duration for the bounded pace preflight and calendar/FIT
requests; no continuation is scheduled when the request ends.

## Manual protocol

1. `queue(owner, { localWorkoutId, expectedRevisionId,
expectedPublishRevision })` reads approval from the trusted reader and commits
   an intent. It requires no connected provider and makes no network calls.
   The queued `payload` is separate from `lastConfirmedPayload`, the last
   provider-confirmed prescription. Queue/retry never promotes an intent into
   the confirmed baseline. Failed/uncertain retries retain the earlier before-state;
   unreconstructable legacy state stays explicitly unknown.
   An initial publication expects revision `0`; the receipt returns revision `1`.
   Exact repeated clicks return the existing receipt. A changed approved snapshot
   requires the latest publication revision, otherwise it returns a conflict.
2. After explicit owner confirmation, `dispatch(owner, { publicationId,
publishRevision })` claims that single receipt. Retry calls the same method.
   There is no automatic draining, Cron, worker or Garmin sync.
3. A per-workout transaction advisory lock serializes first creation and updates
   across instances. A durable two-minute lease rejects concurrent dispatch.
   An expired lease can be reclaimed only by manual dispatch; its old attempt is
   marked interrupted. Lease tokens fence late database completions. A separate
   durable `pendingWrite` survives lease expiration; retry cannot send another
   calendar mutation until that specific prior write is resolved.
4. Credentials come from RUN-39's encrypted owner vault. The actual authenticated
   athlete ID is read and persisted **before** calendar writes. Key replacement
   for the same athlete can recover; a different athlete is blocked. Old remote
   IDs are never reused against another account. Credential nonce and approval
   are checked immediately before writing and again during final status commit.
5. A stable `running-coach:<owner UUID>:<logical workout UUID>` external ID is
   reused for all revisions. The SHA-256 hash covers the validated canonical
   intent, including revision, definition, cancellation, date and zone. Attempt
   rows retain the publication revision, hash, timestamps and safe error code.
6. Before writing, reconcile by saved remote event ID, or scan the original
   intended date if a create returned no ID **or the saved numeric ID returns
   404**. Recover and persist a replacement ID matching the stable external key;
   a stale numeric ID's absence alone never establishes cancellation. Reject
   mismatched numeric/external identities, duplicate matches and failed lookups.
   Nullable provider fields on unrelated calendar entries are accepted, while
   the app's own prescription must still match the intended fields and FIT.
   Create/update/reschedule use calendar bulk upsert with a unique per-write
   `running-coach-write:<UUID>` tag persisted before the request. Cancellation
   targets the verified **numeric** event ID, so a delayed delete cannot remove
   a later recreated event. A lost response remains uncertain, retains the
   intent, and is recovered by readback on explicit retry. No blind second POST
   is issued when readback already matches.
7. Pace workouts reuse RUN-40's owner-bound preflight. Successful calendar write
   is read back and the exported FIT prescription is checked with RUN-40's
   verifier. Export/readback failure retains remote identity and an uncertain
   receipt; retry reconciles and verifies again. A newer approval supersedes old
   intent only after any pending write is resolved, without resending its
   prescription. The owner then explicitly queues the new revision.
   Successful verification advances the confirmed payload. When a superseded
   effect is proven by matching remote readback, its observed payload becomes
   the baseline for the separately confirmed successor.

A pending upsert is resolved by its exact unique tag and intended prescription
in provider readback, or by a valid acknowledged write response. An empty calendar,
an older tag, changed approval, lease expiry, or a later identical prescription
does not prove completion. A pending numeric-ID cancellation is resolved by
acknowledgement or verified absence of that specific numeric ID. Explicit HTTP
401/403/429 rejections release only the just-attempted write; transport failures,
server errors, malformed responses and missing markers retain uncertainty.

`list(owner)` reads local status only, returns at most the 100 most recently
changed receipts, and exposes no credential bindings, provider body or raw error.
Its DTO and browser-safe status copy are in `src/lib/workout-publication.ts`.
An expired running receipt is presented as uncertain. Locally approved with no
receipt remains a separate state in the planning UI.

## Truthful downstream status

Queued, failed, uncertain, superseded, cancelled and published are distinct.
`PUBLISHED` means the Intervals calendar and FIT prescription were verified;
`garminConnect` and `watch` remain `UNVERIFIED` in every response.
The UI uses the supplied status labels and downstream guidance:
connect Garmin Connect in Intervals Settings, enable **Upload planned workouts**,
inspect Garmin Connect, sync the watch and verify the workout on the device.
Cancellation in Intervals also does not prove removal from the watch.

## Provider assumptions and limits

Calendar endpoint contracts were checked against the provider's
[OpenAPI specification](https://intervals.icu/api/v1/docs) and its
[planned-workout guide](https://forum.intervals.icu/t/uploading-planned-workouts-to-intervals-icu/63624).
RUN-40's existing bounded personal-key experiment demonstrated stable bulk-upsert
event identity. No new live provider mutation or device check was run for RUN-41.
The public contract describes upsert/external-ID scoping in terms of OAuth
applications, so repeat the personal-key recovery scenarios before release.

The provider does not expose application revision fencing. Leases fence local
commits and stable external IDs prevent duplicate creation, but cannot cancel an
already accepted remote request. A unique marker therefore permits only one
unresolved upsert per workout; newer approval cannot release that protection.
If approval changes during a call, superseding waits for acknowledgement or
marker verification before the newer approval can be published. If a process
dies after saving intent but before sending, or the provider never commits the
request, absence cannot safely establish that no future commit will arrive.
That receipt stays blocked and requires operator/provider evidence that the old
request can no longer execute; there is no automatic timeout-based reset or
unsafe user-facing override. Older pre-marker uncertain receipts migrate as
`LEGACY` and likewise require operator reconciliation. Do not simply clear
`pending_write` or treat a delay as proof. Marker retention/readback through
personal API keys must still be confirmed with the live provider before release;
missing markers fail closed. If a user manually moves an
event whose create response was lost outside the original date, initial readback
cannot locate it; safety then relies on the provider's stable external-ID upsert.
Oversized or malformed readback fails closed instead of assuming absence.
RUN-31 integration must also establish the provider calendar timezone contract.

Postman CLI was unavailable and no simulation workspace search/run is claimed.
The local stateful HTTP stand-in follows these calendar contracts and returns
501 for unimplemented paths. Tests exercise real HTTP serialization and lost
responses against this stand-in, plus real PostgreSQL constraints and leases.
Those tests establish local recovery behavior, not universal provider/device
delivery guarantees.

## Migration and operations

`20261115090000_run41_publication_outbox` adds two empty tables, their indexes,
owner foreign keys and state/bounds checks. It changes no approved plans or
existing athlete data. The attempt-to-publication composite foreign key prevents
cross-owner attachments. Personal data is service-scoped; no RLS claim is made.
The runtime grants script includes both tables.

`20261115103000_run41_unresolved_writes` adds nullable JSONB `pending_write`
without rewriting approved data. It backfills existing `RUNNING`/`UNCERTAIN`
receipts with a conservative legacy recovery marker and preserves other states.
The column requires no new table grants. This additive change takes a short
table lock and updates only affected recovery rows; schedule migration before
deploying the new client. Do not roll back to a writer that ignores pending
intents: disable publication first and retain the column/recovery data.

Deploy order: back up/confirm the target, use the existing guarded migration
sequence, rerun runtime grants, then deploy the generated client/application.
For local development, run `pnpm db:assert:development` before `pnpm db:migrate`,
then `pnpm db:grant:runtime`. Production uses the production guard and established
release runbook. New-table/index creation takes catalog locks; no existing table
backfill or destructive alteration is required.

Rollback the application first and preserve publication/attempt rows: they are
needed to recover remote effects. Do not drop the outbox or recreate calendar
events as a retry strategy. Use the database backup/PITR procedure if recovery
is needed. Fresh full migration and existing-development upgrade were both
verified locally; no production migration or Neon-specific deployment was run.

## Validation

`pnpm test:db` now includes `publication.integration.test.ts`. The new cases cover
USER/ADMIN owner isolation, nested foreign keys, concurrent clicks and dispatch,
stale revisions, locked/missing approval, create/update/reschedule/cancel,
interrupted leases, committed writes with lost responses, manual recovery,
account replacement/rotation, export failure and unchanged approved snapshots.
Adapter tests exercise HTTP requests, malformed/oversized responses, provider
permissions, rate limits, unrelated IDs and duplicate external-ID readback.

Final local checks on 2026-11-15:

| Check                                              | Result                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                | Passed                                                                                        |
| `pnpm lint`                                        | Passed                                                                                        |
| `pnpm typecheck`                                   | Passed                                                                                        |
| `pnpm test --maxWorkers=2`                         | 1,348 passed; 139 guarded DB/live tests skipped                                               |
| `pnpm test:db --maxWorkers=2`                      | 133 passed, including 28 RUN-41 cases                                                         |
| `pnpm build`                                       | Passed                                                                                        |
| `pnpm exec prisma validate`, `pnpm db:status`      | Valid; all 20 migrations applied                                                              |
| Existing local database upgrade and runtime grants | Passed after development target guard                                                         |
| Fresh temporary local database                     | All 20 migrations applied; recovery backfill verified separately; temporary databases removed |

Twenty-three adapter/contract tests cover the HTTP and hashing boundary in the ordinary
suite. The 28 additional database tests exercise the service, real PostgreSQL and
the HTTP stand-in. Storybook was not rebuilt: no shared UI or stories changed.
Production/Neon deployment and new real provider/device tests were not run.

The first standard Prisma client generation attempts encountered an existing
Windows engine DLL lock. Generation succeeded into a temporary directory; its
JavaScript/types were installed while retaining the identical pinned engine DLL.
The temporary files were removed, and all database/build checks above used the
resulting client. The committed generator configuration remains unchanged.

One existing activity-history integration test was intermittent: its random-UUID
candidate selection could include a legacy unverified activity already excluded
from dashboard totals. Its fixture query now selects verified synthetic Garmin
records. No activity/dashboard application behavior changed.

Review follow-up fixed two confirmed recovery defects:

- After publish/cancel/recreate with a lost create response, the saved numeric
  event ID can refer to the deleted event. Lookup now falls back to the stable
  external key on the intended date after a 404, persists the replacement ID,
  and allows a later approved cancellation to remove the recreated event. A
  PostgreSQL/HTTP regression verifies the complete sequence and repeated cancel.
- Unrelated calendar entries can contain nullable provider fields. Readback now
  accepts those nulls, while exact prescription matching and FIT verification
  remain required before publication succeeds. Adapter and PostgreSQL/HTTP
  regressions cover coexistence with unrelated nullable workouts, identity
  mismatches, and lookup errors that must never be interpreted as absence.

The first follow-up full test run hit the existing Prisma configuration import
timeout during the parallel production build. The complete repeat after the
build passed with two workers; no timeout or test assertion was weakened.
Those first review fixes required no additional schema migration and left the
agreed RUN-33 integration boundary unchanged.

A second review follow-up fixed unresolved late writes and JSON hash stability:

- Per-write tags and durable `pending_write` prevent a timed-out create/update/
  reschedule from committing after a newer revision has been published. A changed
  approval cannot mark unresolved intent superseded. Numeric-ID cancellation
  prevents a late delete from targeting a replacement event.
- Hash canonicalization now omits undefined optional object properties, exactly
  matching the JSONB round trip. A nested optional-step-name contract case and
  real PostgreSQL publication regression cover the former failure.
- Regressions delay each calendar operation beyond the HTTP timeout, retry with
  newer approval while the write is still blocked, then let it commit and verify
  that only the latest explicitly published revision remains. Tests also cover
  unchanged approval, expired leases, older markers, legacy uncertainty and
  explicit rate-limit rejection.

The additive recovery migration was applied to guarded local development and
verified against a fresh temporary database and representative synthetic recovery
rows. Both temporary databases were removed. No production/provider mutation was
performed. The Windows engine DLL lock recurred; client generation used a temporary
workspace output while retaining the identical pinned engine DLL, followed by
cleanup. RUN-33 integration was still pending at that foundation stage.

## Completion verification (2026-11-16)

The remaining saved-status UI gap is implemented in
`src/app/(auth)/app/training/plan/revision-publication.tsx` and the owner-scoped
`src/server/plans/publication.ts` preview. Browser-safe types and lease presentation
are in `src/lib/plan-publication.ts` and `src/lib/workout-publication.ts`;
`src/server/intervals/publication.ts` shares the same expired-lease status logic.
Co-located unit/browser tests and stories cover persisted statuses, earlier
revisions, local-only approval/cancellation, retry confirmation and credential
binding exclusion. The persisted-reader PostgreSQL/HTTP regression now checks
saved published/cancelled statuses, stale-revision labels, foreign-owner rejection
and zero provider calls during status reads. The wizard fixture and the delivery
and refresh guides were updated for this contract.

| Command                       | Result                                    |
| ----------------------------- | ----------------------------------------- |
| `pnpm db:assert:development`  | Passed against local PostgreSQL           |
| `pnpm format:check`           | Passed                                    |
| `pnpm lint`                   | Passed                                    |
| `pnpm typecheck`              | Passed                                    |
| `pnpm test --maxWorkers=2`    | 1,648 passed; 211 guarded DB/live skips   |
| `pnpm test:db --maxWorkers=2` | 205 passed, including all 30 outbox cases |
| `pnpm build`                  | Passed                                    |
| `pnpm build-storybook`        | Passed with bundler/deprecation warnings  |
| `git diff --check`            | Passed                                    |

The 205 DB tests ran separately against guarded local development PostgreSQL
with synthetic fixtures and local HTTP provider stand-ins. Live tests remained
disabled. No new migration, environment variable, provider mutation, deployment
or remote Git operation is required by this follow-up. Existing publication and
confirmed-baseline migrations remain prerequisites. Physical browser mobile/zoom
inspection, live personal-key marker/upsert recovery and Garmin device delivery
remain unverified; automated browser tests use jsdom. Linear's current RUN-41
description and acceptance criteria were read and matched the supplied ticket;
its status was not changed.

## Implementation handoff

Suggested change title: `feat(intervals): complete RUN-41 saved publication statuses`.

Suggested PR description: Restore owner-scoped publication statuses when reviewing
an approved plan, including settled receipts, local-only approval/cancellation and
expired attempts. Label earlier revisions explicitly, retain manual confirmation
for publication/recovery, and keep Garmin delivery unverified. Add unit, browser,
PostgreSQL/HTTP coverage and feature stories. Validation and external verification
limits are listed above. The current changes are uncommitted on `development`.

Original foundation files (historical):

- `src/server/intervals/publication.ts`, `publication-contract.ts` and
  `publication-client.ts`: owner-authorized intent, leases, provider I/O and recovery.
- `src/server/intervals/publication-client.test.ts`,
  `publication-contract.test.ts`, `publication.integration.test.ts` and
  `publication.fixtures.ts`: contract, failure and PostgreSQL coverage.
- `src/lib/workout-publication.ts`: browser-safe DTO/status and Garmin guidance.
- `prisma/schema.prisma`,
  `prisma/migrations/20261115090000_run41_publication_outbox/migration.sql`,
  `prisma/migrations/20261115103000_run41_unresolved_writes/migration.sql` and
  `prisma/scripts/grant-runtime.sql`: additive storage and runtime grants.
- `package.json`: include publication cases in the guarded database suite.
- `src/server/activity/history.integration.test.ts`: deterministic eligible
  duplicate candidates for an existing assertion.
- `docs/intervals-publication-outbox.md` and `docs/intervals-workout-delivery.md`:
  protocol, operations, limitations and integration boundary.

The foundation is now connected to RUN-33/38's production approval reader,
ownership-compatible plan foreign keys, authenticated publication actions and
separately confirmed publication/recovery UI. The remaining release checks are
real provider marker/upsert behavior, downstream Garmin/device delivery and
deployed-environment behavior. Local PostgreSQL/HTTP tests establish the app's
recovery protocol, not those external guarantees. No issue status, commit or
remote Git operation was changed.
