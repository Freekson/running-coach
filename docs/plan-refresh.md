# Approved plan refresh (RUN-38)

Issue: [RUN-38](https://linear.app/fr-running-coach/issue/RUN-38/build-plan-refresh-flow-diff-and-conflict-handling).

## Athlete workflow

Open **Refresh approved plan** from Training (`/app/training/plan/refresh`). Choose
one of your current approved plans, then use the existing three-step wizard:

1. Open the refresh draft for that exact plan/revision and choose a future 14, 21
   or 28-day window. Goal and approved constraints are reused; profile defaults
   and goal editing are not part of refresh. The saved macro strategy is retained.
   The existing goal-export entry point also keeps approved refresh constraints
   fixed. Reopening a draft with divergent constraints starts a new refresh draft
   from the approved snapshot and retains the older draft for recovery.
2. Choose the existing privacy opt-ins, inspect the request, copy/download it for
   manual ChatGPT generation, and upload/paste the response. All activity/health
   observations come from persisted manual syncs. No provider sync or OpenAI API
   request is triggered. RUN-35's narrative-withholding policy remains in place:
   exported approved macro/workout text uses structural projections, while the
   local review shows the owner's actual saved strategy and prescriptions.
3. Validate, inspect the created/changed/canceled/unchanged diff, resulting calendar
   and workload warnings, acknowledge warnings and explicitly approve locally.
   Refresh changes near-term detail only; imported macro placeholders do not
   replace the original strategy. Omitted workouts retain their definitions,
   timezone, stable IDs and dates. Completed/past/locked sessions remain protected.

Work-in-progress storage uses separate owner-and-plan browser keys. Restored text
must be revalidated; warning acknowledgements and approval are not restored.
Stale drafts, requests, revision pointers or completion evidence provide reload
and re-export guidance. **Reload approved plans** reloads the current selection
without discarding the saved response. It never overwrites a newer approved plan.

When a goal date no longer matches the approved macro horizon, opening/exporting
a refresh is blocked before issuing a request. Existing requests are also rejected
at preview/approval with new-plan guidance and no repair/re-export loop. Use
**Create a new plan for an updated goal**; the original strategy and revisions
remain unchanged. Preview and approval validate against the same goal date.

Refresh export also checks both selected window boundaries against the approved
macro period, including goals without a target date. An out-of-range window is
rejected before issuing a request, with the approved dates and guidance to choose
an in-range future 14–28-day window or create a new plan. The rejected export does
not supersede the previous request or change an approved revision.

## Persistence and history

`exchange/proposal.ts` builds both approval content and the local diff from complete
persisted membership, never from redacted request labels. It explicitly supplies
retained active prescriptions to RUN-33's merge so omissions cannot become
cancellations. Existing cancellation tombstones remain in full revisions without
consuming the bounded active detail-content capacity.

`approvePlanImport` reruns issued-request, owner, warning and live lock/version
checks inside the same serializable transaction as draft validation and immutable
revision approval. The current-revision compare-and-swap and transaction retries
produce one successor for concurrent submissions. All failures roll back local
writes; previous revisions and calendar associations remain intact.

`/app/training/plan/<planId>` lists retained revisions. Each version has its original
schedule, canonical steps and a downloadable snapshot including goal, constraints,
macro strategy and cancellation membership. Recovery is inspection/export; an
older version is not silently restored over completed history.

## Separate publication

Approval creates no outbox intent and makes no provider request. After refresh
approval, or from the current revision's history page, **Review Intervals.icu
changes** compares editable future sessions against the last confirmed publication.
It is a local comparison, not a claim that the live remote calendar was read.
Each create/update/reschedule/cancel has before/after dates, zones and steps,
a separate confirmation checkbox and an explicit send button.
The same review restores saved per-workout publication statuses after a page
reload, including settled receipts omitted from the pending diff. Local approval
without a receipt is labeled separately. A receipt from an earlier revision is
identified explicitly and cannot confirm that the current approved date or
prescription was sent. Status review reads local data only; it never sends or
retries a provider operation.
Both sides of the shared diff also show the sport, including sport-only changes.
If an approved prescription cannot be mapped by the Intervals.icu adapter (for
example, absolute-HR targets or a non-running sport), publication explains the
capability limitation and preserves the local approved revision. Approve a
compatible workout through refresh before attempting publication again; retrying
an unsupported prescription does not make it publishable.

The outbox stores `lastConfirmedPayload` separately from its mutable `payload`
intent. Queueing, failed reads and rejected/lost responses never replace the
confirmed before-state. A retry therefore retains the original A-to-B reschedule
diff and operation. Confirmation advances only after successful provider readback
and verification, or reconciliation that proves an older superseded effect.
Uncertain outcomes are labeled explicitly; their baseline is a historical
reference, not a claim about current remote state. Legacy receipts without a
reconstructable baseline show **previous confirmed schedule unknown**, rather
than displaying their pending intent as an unchanged remote workout.

The server binds confirmation to the exact approved revision, workout and outbox
baseline. It rechecks that review before calling RUN-41's queue/dispatch methods.
`readApprovedPlanWorkout` locks the plan pointer in the supplied transaction and
reads the current approved membership with owner scoping. Past/completed/locked
workouts cannot be sent. The outbox retains stable remote identity, retries,
credential/account checks, remote reconciliation and FIT verification.

An uncertain prior intent is explicitly reconciled first, with a separate recovery
confirmation. RUN-41 refuses to replay obsolete prescriptions. The user reviews
and confirms the new operation afterward. No automatic drain, Cron, Garmin
Personal API write or publish-on-import/approval is introduced. Displayed statuses
distinguish Intervals.icu acceptance from unverified Garmin Connect/watch delivery.

Unresolved receipts remain available for recovery after a workout becomes past,
completed or locked. These entries offer a recovery check only. The outbox resolves
the earlier effect and supersedes its intent without replaying the protected
prescription; resolved protected entries then leave the pending list.

## Verification and deployment

Apply `20261116020000_publication_confirmed_baseline` before deploying this code.
It adds nullable JSONB `workout_publications.last_confirmed_payload` and backfills
only settled PUBLISHED/CANCELLED receipts without a lease or pending write.
Existing uncertain/failed/superseded intents remain unknown. The additive ALTER
takes a brief table lock; the backfill updates settled rows without deleting data.
Pause manual publication and let in-flight requests finish during rollout so the
old app cannot overwrite publication history while it lacks baseline support.
Existing table grants cover the new column; no new grants, dependencies or
environment variables are required. Existing RUN-33/35/41 tables, request issuance
sequence and runtime grants must already be deployed. A code rollback can leave
the additive column in place; do not drop it or infer old unknown baselines.
Planning works without provider credentials; only confirmed publication needs the
athlete's Intervals.icu connection.

Coverage includes deterministic proposal/diff cases, omitted definitions and
accumulated tombstones, explicit warning/approval gates, restored browser state,
authenticated pages/actions, cross-user and ADMIN isolation, concurrent refreshes,
late locks, immutable history, publication review tokens, separate recovery and
publication confirmations, and a persisted-reader/outbox test using local HTTP.
Feature stories include refresh review and publication at narrow widths.

Real Intervals.icu/Garmin delivery, device verification and deployed-environment
behavior remain manual checks. Automated browser tests use jsdom; physical browser
zoom, keyboard and mobile visual inspection remain unverified.
