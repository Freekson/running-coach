# Privacy-controlled planning request export (RUN-35)

Open **Goals → Plan request → Start request** to reuse an editable owner draft,
or create one from the current approved revision or profile schedule defaults.
GET/page rendering never creates a draft. The authenticated server actions own
all mutations. This screen exports a planning request, not an account or general
training-history archive, and needs no OpenAI or Intervals.icu credentials.

Choose a future 14–28-day detail window and edit the draft's weekday, session and
time limits. The goal's distance, deadline, surface and elevation remain in the
request. Schedule edits use the existing optimistic draft version check and clear
old generated draft content. Approved revisions and completed history never change.

All six consent choices start off: recorded running metrics, per-run HR, laps,
optional athlete background, limitations/fatigue, and recovery. HR/laps require
recorded metrics; limitations require athlete background. Optional experience is
explicitly unknown until reported; legacy profile `BEGINNER` defaults never imply
first-ever training. Reports support previous experience/breaks/travel, perceived
easy effort, non-running workload, preferences and dated race/test/PB evidence.
The UI offers a skippable result; the typed service accepts up to five results.
Review free text, including the goal title, before sharing it externally.

**Prepare export preview** saves an immutable issued request. The preview shows
coverage, the last recorded run, 4/8/12-week totals, background and exclusions,
plus the exact request and full copyable prompt. Editing any selection removes
the old preview and its copy/download actions. Both outputs use the exact stored
snapshot, including PostgreSQL's normalized JSON numeric precision. The JSON
includes the complete RUN-34 response schema and generation instructions.

## Stored evidence and limits

`src/server/plans/exchange/export.ts` reads the goal, draft, athlete unit preference,
approved revision/commitments, coverage cursors and canonical activity/health rows
in one serializable transaction. No Garmin API, automatic sync, FIT download,
Intervals.icu delivery reference or publishing code is invoked.

The RUN-34 deterministic selector reserves the longest and fastest evidenced runs,
then the newest, with timestamp/ID tie-breaks. Only completed dated running
observations enter running totals; unresolved duplicates and non-running sports
are excluded. Limits are 20 runs, eight FIT laps per run and 40 laps overall.
Excluded/truncated counts are explicit. Moving and elapsed duration remain
separate, with pace basis and per-run HR/provenance preserved. These observations
do not classify easy/tempo/race effort or measure physiological thresholds.

Weekly and 4/8/12-week totals are null when verified import coverage is incomplete,
including failed/unfetched periods or unresolved duplicates. Complete checked
periods can report zero recorded sessions; absent Garmin data never proves zero
real-world training. Calendar windows use the draft timezone and end yesterday.
The historical-import status/window is separate from recent 12-week coverage.
Timezone-mismatched or unrecognized checkpoints cannot establish complete history.
Manual activity sync persists merged `confirmedWindows` in the existing
owner/connection-scoped checkpoint. Advancing the recent window carries those
verified closed-day ranges forward, preserving 4/8/12-week coverage. Overlapping
or adjacent ranges merge; gaps are never inferred from stored activities. Today's
fetch cannot confirm a full local day. Account replacement/disconnect clears
cursors, and timezone changes do not carry dates from a different timezone.
Legacy checkpoints without cumulative ranges keep unknown gaps until a manual
import actually verifies them; export never starts a repair sync.
Failed activity windows describe the attempted import range, not a diagnosed day
of inactivity. Sync timestamps describe saved manual progress, not a live fetch.

Opt-in recovery contains at most 28 dated records from the owner's current Garmin
account. Each metric keeps its source timestamp and timezone. HRV needs at least
seven recorded days; fewer observations remain null. Missing dates are explicit.
Instructions allow sufficiently covered trends as context and forbid single-day
clinical safety judgments. No medical questionnaire is required.

Refresh includes the full macro date/phase structure and approved commitments,
explicit completion and locks, and reliable stored Activity links. Previous plan
strategy, phase labels/notes and all workout/step names are withheld: unstructured
approved text has no field-level consent provenance and can repeat excluded health
or background. Generic labels are explicit placeholders. Newly volunteered background
still follows the current consent controls. Source approved records never change.
An unlinked Activity still contributes
to observed load; it never marks a planned session complete. There is no persisted
missed status yet, so unsupported outcomes stay `unknown`. Protected workouts are
excluded from editable IDs. The export retains window locks/completions, active
future commitment and current-week session needed for schedule validation.
Unprotected cancelled identities, including cancellations inside the requested
window, enter only the bounded optional history. It adds
up to 20 newest historical/cancelled commitments while the 200-commitment and byte
limits permit. `commitmentsCoverage` and `omittedHistoricalCommitments` disclose
omissions; omitted records remain intact in approved history. Optional history is
dropped before rejecting an oversized payload. Export fails only if the required
context itself cannot fit. JSON and prompt are each capped at
262,144 UTF-8 bytes before issuance; failures roll back the snapshot insert.

## Persistence, import handoff and deployment

Migration `20261116000000_plan_exchange_requests` adds `plan_exchange_requests`,
a draft composite owner/goal foreign key, a database-assigned issuance sequence,
and an owner/draft/sequence index. It has no
backfill or destructive change. The update trigger and runtime grants make issued
snapshots append-only; deleting their owning draft/account cascades deletion.
Apply the migration before deploying export code, then run the existing runtime
grant step. Migration ownership still belongs to the migration role.

The same migration creates the issuance sequence from the outset; no metadata
backfill or disabled immutability trigger is needed. New issuance uses the sequence
regardless of clock skew or tied timestamps. The runtime role needs `USAGE` on this
sequence, granted by `db:grant:runtime`. Apply the migration and runtime grants
before deploying export code.

Each snapshot binds request ID, schema version, owner, goal, draft/edit version,
time boundaries, coverage and exact consent. `getIssuedPlanExport(owner, id)` is
the RUN-36 entry point: it denies another owner and superseded requests. The
current request is the latest by database issuance sequence for that draft. Import
requires legacy refresh requests without narrative-withholding metadata to be
reissued; their immutable stored JSON is retained, never silently rewritten. Import
must also re-read current draft, goal, revision and locks and use RUN-34's semantic
validator before RUN-33 validation and explicit human approval. Reading an issued
snapshot alone never establishes that its draft/revision is still current.

The v1 request contract adds optional unit preference, historical-import metadata
and moving-duration totals, plus explicit refresh narrative/omission metadata.
Existing v1 fixtures remain readable; the response
contract and canonical workout definitions are unchanged. Generated schemas and
fixtures come from `pnpm contracts:generate`.

Rollback the app independently if needed and retain the additive table/snapshots.
Do not drop issued evidence while downstream responses may still reference it.
Production migration/grants and real desktop/mobile clipboard/download rendering
need environment-specific verification; component interaction tests run in jsdom.
Headless Edge checks the synthetic screen at 375px, 320px with optional background,
and 320px at 200% CSS zoom. The shared date trigger now wraps inside narrow grid
tracks, with a `ZoomedWidth` Storybook example. These checks verify layout, dark
canvas and heading font, rather than physical-device clipboard permissions.

## Verification

Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
and `pnpm build-storybook`. `pnpm test:db` includes synthetic export integration
tests behind the existing development/test database guards. It checks tenant
isolation including ADMIN, composite FK rejection, immutable snapshots, identical
stored/downloaded data, opt-in recovery and superseded consent. Unit/browser tests
cover first-use experience states, dated evidence, missing/failed coverage,
per-category consent, refresh scope, payload/sample/lap limits, invalidation,
copy/download, clipboard failure and unauthenticated actions. Review regressions
also cover nested prior-plan text, 200+ retained commitments, optional history over
the byte limit, 200+ cancelled identities inside one detail window, same-timestamp
reverse-UUID ordering, concurrent issuance and cumulative manual sync coverage.
