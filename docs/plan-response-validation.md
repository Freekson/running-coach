# Plan response validation and repair (RUN-36)

`src/server/plans/exchange/import.ts` exposes `previewPlanImport(owner, command,
jsonText)`. The command selects `goalId`, `draftId` and the issued `requestId`;
ownership comes exclusively from a verified server session. The server action at
`src/app/(auth)/app/goals/[id]/import/actions.ts` authenticates and delegates.
RUN-37 owns the wizard UI and subsequent explicit approval/persistence flow;
RUN-38 owns refresh diff presentation. Neither is added by this issue.

## Validation boundary

The service reads the immutable issued request, latest issuance sequence,
current owner-scoped Goal/Draft, plan pointer, revision and workout locks in one
serializable transaction. A foreign or unknown request has the same result,
including for ADMIN. Changed goals, constraints, draft versions, superseded
requests and approved revisions require a new export. New logical workout IDs
cannot collide with existing IDs in any plan. Live completion, lock and local-date
checks supplement the original request-relative contract checks. The detail
window must still be entirely future at import time. Completion timestamps are
compared for every commitment in the issued snapshot, including sessions omitted
from the response. A completion change requires a fresh export before any
workload preview or prior warning acknowledgements can be accepted.

`validation.ts` provides the same provider-neutral `validatePlanResponse`
pipeline for manual responses and a future generation adapter. It reuses RUN-34
Zod contracts and RUN-28 canonical WorkoutDefinition semantics. There is no
alternative provider-specific validation or threshold configuration. The shared
validator defaults to the export date for reproducible request-relative checks;
the authenticated service supplies today's athlete-local date so evidence ages
correctly even when the user waits before importing.

- Incoming text is capped at 128 KiB UTF-8 before parsing. Arbitrary JSON nesting
  is limited to 32 levels, counting outside escaped strings. Canonical workout
  repeat depth/count/group bounds still apply independently.
- Repeat expansion is counted algebraically: at most 10,000 expanded steps per
  created/updated workout and 100,000 across definitions submitted in the response.
  Unchanged approved definitions, including locked commitments, are preserved
  without applying new import caps retroactively. They still contribute to
  workload estimates; canonical structure and input byte/depth bounds still apply.
  Loops are never expanded in memory.
- Dates, weekdays, full macro horizon, contiguous phases, request identity,
  version, detail window and calendar-week capacity use the issued contract.
  Duration limits additionally include pace-based estimates. A measurable
  contradiction blocks; an unbounded manual-lap/distance duration produces an
  explicit review warning instead of an invented pace. Unchanged protected
  commitments retain the existing contract's duration-preference exception.
- Explicit create/update/cancel operations preserve omitted commitments.
  Validation against RUN-33's replacement merge supplies original retained
  definitions explicitly, including protected history. Privacy-filtered export
  labels never overwrite approved source text.

The result is either blocking `errors` with typed `(string | number)[]` JSON paths
and `expected` values, or a valid preview containing the parsed response, proposed
running sessions, weekly totals and reviewable warnings. Contract errors include
a minimal copy-ready repair prompt. Authorization/staleness/live-lock errors
instead ask for a fresh owner-authorized export and return no AI repair prompt.
Errors never include submitted values, unknown property names, source health/GPS
context, original JSON or infrastructure exception text. At most 40 contract
errors enter a repair prompt.

## Recorded workload method

`training-load.ts` publishes `LOAD_METHOD_VERSION = recorded-load-v1` and the
reviewable constants in `LOAD_REVIEW_RULES`. These are triage heuristics, not
clinically validated limits or promises about a safe percentage increase. A valid
preview is never a medical or physiological safety judgement.

Proposed totals cover successive seven-day periods anchored to the 14–28-day
detail window, including a labelled final partial period. Scheduling capacity
still uses local Monday–Sunday calendar weeks. Observed comparisons use the last
four completed seven-day evidence windows in the issued snapshot. Only complete
weekly metrics contribute to frequency/duration/distance averages; partial or
missing totals remain unknown. Warning evidence includes proposed and observed
values/units, affected session IDs, period and available complete-week count.

The v1 review rules flag:

- Frequency above 1.5 times the available recent weekly average **and** at least
  two extra sessions.
- Weekly minimum duration/distance above 1.75 times that average **and** at least
  1,800 seconds / 5,000 metres extra, respectively.
- Longest proposed sessions above 1.75 times recent observations **and** at least
  1,200 seconds / 3,000 metres extra. Distance uses complete weekly longest-run
  metrics plus recent samples; partial evidence lowers confidence. Duration uses
  selected samples and is always low confidence because the sample can omit
  another long session. Historical PBs and runs outside the recent 28 days never
  establish these baselines.
- Three sessions with at least 300 seconds or 1,000 metres of targeted repeat
  work in a proposed week; also targeted-repeat sessions less than two calendar
  days apart. Repeats include recovery and are not asserted to be hard workouts.
  Interval seconds/metres are shown, while historical hard-work volume remains
  unknown rather than inferred from average HR, laps or workout names.

Sufficient, fresh coverage with four complete recent metric weeks can produce
moderate confidence volume/frequency warnings. Partial, absent, withheld or stale
history lowers confidence and adds an explicit uncertainty warning. A recording
gap over 14 days is described as a recording gap, never proof of inactivity.
Missing HR/pace/laps/HRV do not block a plan. Old PBs, volunteered fatigue and
recovery metrics do not set hard limits or produce diagnoses.

Canonical v1 prescriptions lack session-specific terrain, climate, effort and
sensor-reliability evidence. Even paired historical whole-run pace/HR cannot
prove comparable easy versus interval conditions. Paced prescriptions therefore
receive a low-confidence comparability caution; v1 does not assert an aggressive
pace mismatch or invent threshold pace from easy runs or delivery-only
Intervals.icu settings. Any future numerical pace comparison needs an explicit,
validated comparable-evidence contract and new method version.

## Explicit review and publication

Warnings have deterministic IDs bound to the parsed request, response, evaluation
day and method. Send `acknowledgedWarningIds` and optional `warningRationale` to
recompute the preview. A changed response invalidates previous acknowledgements.
Missing acknowledgements do not make the JSON invalid; they leave
`readyForExplicitApproval: false`. Even fully acknowledged previews always return
`requiresExplicitApproval: true`, `approved: false`, `published: false`.

Preview performs **no writes**, including on valid input. Nothing calls Garmin,
Intervals.icu, OpenAI, approval services or publication outboxes. The next approval
flow must rerun live validation and warning review server-side; never trust a
client-returned preview or reuse a preview after a lock/version change. RUN-33's
explicit approval repeats identity/history checks. Publication remains a separate
user-confirmed RUN-41 action.

## Verification

`pnpm test` includes synthetic novice, returning runner, established runner,
incomplete history, old PBs, hills, missing HR/laps, easy-only observations,
high/modest load, invalid nesting/byte sizes/repeat expansion, typed repair paths,
date/weekday/duration constraints, DST and warning acknowledgement tests.
Mocked serializable retries recheck newly acquired locks. The guarded
`import.integration.test.ts`, included in `pnpm test:db`, exercises real PostgreSQL
ownership, superseded exports, changed draft constraints, concurrent refresh
approval, newly completed workouts and preservation of drafts/approved revisions
without publication mutations. It requires the existing isolated nonproduction
database guards. No schema migration, new environment variable or dependency is
needed.
