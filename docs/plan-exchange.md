# Manual plan exchange v1 (RUN-34)

RUN-34 defines the provider-neutral JSON boundary for manual ChatGPT generation
and a possible future generation adapter. It adds no UI, provider reads/writes,
automatic approval or database migration. RUN-35 owns owner-authorized export and
privacy selection UI; RUN-36 implements import preview, repair prompts and live
staleness checks in [plan-response-validation.md](plan-response-validation.md).
RUN-33 remains the only persistence and explicit approval store.

## Authoritative schemas

- `src/schemas/plan-exchange.v1.ts`: strict initial/refresh request and response
  envelopes, approved commitments and explicit operations, request-relative
  correlation, calendar and scheduling validation.
- `src/schemas/training-context.v1.ts`: versioned training context, nullable metrics,
  provenance, coverage, self-report and optional recovery.
- `src/schemas/plan-content.v1.ts`: shared macro/window and persistence shapes,
  extracted without changing RUN-33's existing data format or imports.
- `src/schemas/workout-definition.v1.ts`: the single authoritative RUN-28 workout
  definition, reused directly. No FIT, Garmin, Intervals.icu or UI payload is added.

Inferred TypeScript types and JSON Schema come from Zod. The exported
`planExchangeRequestJsonSchema` and `planExchangeResponseJsonSchema` use Draft
2020-12. Actual JSON files, valid fixtures and invalid fixtures with expected
typed paths live in [fixtures/plan-exchange-v1](fixtures/plan-exchange-v1).
Regenerate with `pnpm contracts:generate`; ordinary tests compare every generated
artifact with its committed file and roundtrip valid initial/refresh examples.
Generation uses synthetic records and requires no database or credentials.

JSON Schema describes the complete structural contract, including bounded nested
workout steps. Cross-field comparisons, real calendar dates/timezones, consent,
coverage/null semantics, matching IDs/versions, phase continuity and scheduling
require Zod semantic validation as described in the schemas' `$comment`.
Passing JSON Schema alone does not establish safety or approval.

## Request and generation package

A request carries numeric `schemaVersion: 1`, a UUID `requestId`, generation
instant, athlete-local date and IANA timezone, the canonical Goal snapshot, and
the draft ID/version and authoritative RUN-32 `draft.constraints`. Goal surface,
elevation and race/target date remain in Goal; available weekdays (Sunday = 0),
sessions/week, maximum minutes and start date remain in the copied draft
constraints. These fields together with `trainingContext.athleteReport` form
training preferences and constraints; there is no parallel schedule model.
Do not replace saved draft constraints with current profile defaults.

`createPlanExchangePackage(request)` returns a JSON-serializable object with
`request`, the **entire** `expectedResponseSchema` and explicit `instructions`.
See `initial.package.json` and `refresh.package.json`. The response must echo
version, request ID, mode and draft version. A valid package is not an approval.
Caller authorization is required before assembling this private snapshot.

`parsePlanRequestJson` accepts the bare request field. `parsePlanResponseJson`
bounds UTF-8 bytes before parsing and validates the response against its request.
The complete outgoing package is capped at 256 KiB; incoming responses are capped
at 128 KiB. Request parsers also reject inputs over 256 KiB. The exporter must
enforce a bound before parsing any uploaded package wrapper.

The detail window contains 14–28 future local days. Responses cover the entire
macro horizon with contiguous ordered phases, while structured workouts remain
within the allowed detail window. Local dates, unique IDs, allowed weekdays,
calendar-week session counts and known time duration are checked. Distance or
manual-lap steps do not establish a reliable maximum duration: instructions
require uncertainty warnings and downstream RUN-36 review. These checks make no
claim to validate physiology or automatically decide appropriate training load.

## Recorded training evidence

`src/server/plans/exchange/evidence.ts` reads stored actual running Activities and
reliably recorded `FIT_LAP` rows. It requires an issued `OwnerContext`, uses the
existing account visibility scope (including saved history after disconnect),
and scopes nested laps to the owner. A forged or unauthenticated context fails
before a database read; ADMIN gets only its own data. No export triggers a sync.

`readTrainingEvidence` takes explicit HR/lap selections and verified sync
coverage supplied by RUN-35. It does **not** infer coverage from the oldest
activity, a connected-account flag, import success count, or absence of rows.
RUN-35 must derive complete/failed/unfetched windows and last **manual** sync
from the relevant owner/account stored import checkpoints. When that evidence
is missing or cannot establish completeness, pass absent/unknown/partial coverage,
never fabricated complete windows. Recovery has its own coverage and consent;
this reader does not query health records.

- The summary covers the 84 completed local days before the generation day,
  as twelve consecutive seven-day windows, oldest first. These are rolling
  windows anchored to yesterday, not calendar Monday weeks. Explicit 4/8/12-week
  totals and recent-four versus previous-four-week distance ratio use those
  absolute dates. Current-day records may establish recency but do not enter
  completed-day summary/sample windows.
- Covered weekly session totals and distance/duration totals are null when
  history is partial, failed, unfetched or contains unresolved duplicates.
  A missing metric also makes its aggregate null. Verified complete empty
  windows have zero sessions/distance/duration and seven days without recorded
  runs. An empty window has no observed longest run, so that metric is null.
  Days without recorded runs describe observations, never proof of actual rest.
- Duration totals use **elapsed seconds**, never silently substituted moving or
  timer time. Per-run elapsed and moving measurements remain separate. Derive
  speed from positive distance and moving time, otherwise elapsed time,
  otherwise a positive recorded average speed. Pace is 1000/speed in s/km.
  Moving time greater than elapsed time invalidates derived speed/pace and
  duration totals; no division by zero or stale fitness inference occurs.
- Per-run pace and HR always belong to that same Activity. Missing HR, cadence,
  elevation or surface stays null. Surface uses explicit recorded values or
  unambiguous stored Garmin subtypes; hills do not imply trail or workout type.
  Metrics have fixed units, source, observation timestamp, measurement period
  and quality. Derived metrics are labelled DERIVED, not athlete reports.
- Keep at most 20 runs: reserve the longest and fastest run with measured speed
  and HR, then fill by recency. This is a representative selection rule; it
  does not classify a session as threshold/hard or establish current fitness.
  Output order is newest first, with ascending UUID for equal timestamps.
  Selection includes its window, eligible count, excluded duplicate-candidate
  count, truncated run/lap counts and a versioned deterministic policy.
- Known unresolved duplicate candidates are excluded entirely, with both
  members excluded. Repeated IDs cannot inflate aggregates. Exclude mixed sports,
  future rows, other owners and unverified/replaced Garmin accounts.
- Include at most eight stored laps/run and forty overall in output order,
  sorted by lap index. No stored laps means null, and no pace/HR-based interval
  classification is invented. No raw FIT, GPS, account IDs, credentials,
  athlete names or activity titles enter the evidence DTO.

The selected samples, weekly summaries and full response schema fit within the
package cap in tests. Export fails with a typed error if the complete serialized
package exceeds the cap; it never silently drops constraints or truncates schema.

## Lifecycle, self-report and privacy

`firstPlanForAthlete` and `firstWorkoutInPlan` are lifecycle facts supplied by the
owner-authorized export flow. They never imply `firstWorkoutEver`. That fact is
nullable and exists only in an optional dated athlete report. Without a report,
first-ever status and experience are unknown. Do not map AthleteProfile's
default experienceLevel or missing Garmin history into verified experience.

Reports accept new_runner, returning_runner, currently_training and unknown,
with separately dated previous experience, easy effort, race/test/historical PB
results, cross-training, preferred workouts and volunteered limitations/fatigue.
Limitations require a separate consent selection. Optional recovery accepts up to
28 unique dated resting-HR (bpm), HRV (ms) and sleep-duration (s) observations with
nullable metrics and independent coverage. It produces no clinical conclusions,
required readiness score or approval condition.

Consent fields cover recorded activity metrics, activity HR, laps, report,
limitations and recovery. Schemas reject populated nonselected sensitive fields;
RUN-35 must apply selections before building the package. Nothing in these
contracts requires medical questions. Prompt instructions require conservative
use of incomplete history and long breaks, with historical PBs kept separate
from recent form. See fixtures for novice self-report, returning after a long
gap, current regular runner, no Garmin account, failed imports, covered emptiness,
mixed sports, missing HR, average-speed-only runs, hilly sessions and
inconsistent times.

Selection metadata is also subject to consent. When activity metrics are
deselected, redact eligible-run, duplicate-candidate and run/lap truncation counts
to zero before package creation; these zeros describe the redacted selection,
not observed training history. When laps alone are deselected, redact their
truncation count as well. Request parsing and package creation reject nonzero
nonselected counts instead of silently exporting them.

## Refresh, versions and errors

Refresh requests include the actual approved plan/revision number, macro plan,
detail window and available commitments, with complete/partial coverage stated.
RUN-33 currently persists completion/lock timestamps; it has no Activity link or
missed-session fact. Leave those links null and unknown outcomes unknown until
an authoritative later feature stores them. Planned workouts never contribute
completed-activity metrics; an optional completion link is not counted again.

Export supplies disjoint lists of editable existing IDs and reserved new IDs.
Update/cancel can target only approved future IDs in the allowed window;
create can use only reserved new IDs. Requests cannot whitelist completed, missed,
locked or past workouts, including the workout's own timezone current day.
Responses cannot change locked dates. Omitted commitments are preserved, never
implicitly cancelled; explicit cancellations are required. Retained future
commitments participate in weekly frequency and macro-horizon checks.

Weekly capacity also includes completed and protected commitments already
scheduled in the same athlete-local Monday–Sunday week. Count stable workout
IDs once, without adding linked Activity samples again; cancelled and explicitly
missed sessions do not consume capacity. An already elapsed week with no future
commitments does not block a refresh of later weeks. Every unfinished future
commitment must remain inside the macro period even when locked, using its
original timezone to determine whether it is past. Completed/past history and
cancelled sessions may remain outside the revised horizon, matching RUN-33.

`responseSchemaForRequest` rejects mismatched request/mode/version, duplicate
operations, malformed definitions and illegal scheduling using ZodError issues
with typed paths. `assertExchangeCurrent` compares the exported request against
the current owner-scoped request, draft and revision state. RUN-36 must perform
that live read and recheck newly acquired locks; RUN-33 repeats ownership, version
and lock checks on validation/approval. Do not trust the old export as current.
Failures never save, modify an approved revision, sync or publish.

Unsupported versions fail at `schemaVersion`; unknown enums/keys fail at their
typed paths. Malformed/oversized JSON fails at the document root. Do not log the
untrusted payload with errors. There is no automatic migration, coercive downgrade
or dropping unknown fields. A future version requires a named explicit migration
with source/target validation and fixtures; unrecognized versions remain rejected.
Schema version, draft edit version and approved revision number are distinct.

## Verification and handoff

Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
RUN-34's contract/artifact tests run without external services; its PostgreSQL
suite is included in `pnpm test:db` behind the existing isolated nonproduction
database guards. It covers cross-user ADMIN isolation, nested laps, saved history
after disconnect, replaced accounts, duplicate candidates and denied forged
contexts. No migration, new dependency or provider capability is required.

PR title: `RUN-34: Add versioned manual plan exchange contracts and training evidence`.
The handoff should link RUN-34 and list actual command results. Downstream work
must wire authenticated export/selection (RUN-35), import/repair/live rechecks
(RUN-36), and explicit operation translation for refresh (RUN-38) into the existing
RUN-33 draft validation and human approval flow.
