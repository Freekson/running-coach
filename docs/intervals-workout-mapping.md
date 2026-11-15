# Intervals.icu workout mapping and watch probe (RUN-40)

## Implementation and evidence boundary

`src/server/intervals/workout-mapping.ts` converts untrusted canonical v1 input to
a planned calendar event. It does not read credentials, load owned records, write
to a database, contact any provider, approve a plan or publish anything. The
owner-scoped `pace-preflight.ts` adds explicit delivery configuration and stores
integration metadata in the existing SyncCursor table. The settings UI and
`/api/integrations/intervals/pace` route expose configuration preparation only.
There is no worker, Cron or ingestion pipeline. RUN-41 owns the
authenticated, owner-scoped, explicit Publish/Retry/Update/Reschedule/Cancel flow
and durable publication state. RUN-39 connect/test retain their read-only probe;
connection copy now discloses the separately invoked delivery-setting writes.

The [provider upload guide](https://forum.intervals.icu/t/uploading-planned-workouts-to-intervals-icu/63624)
documents `description` workout text and file uploads. This adapter uses text,
not an undocumented JSON workout structure. A successful conversion returns
`intervals: NOT_PUBLISHED`, `garminConnect: UNVERIFIED`, `watch: UNVERIFIED`.
An eventual successful API write can establish **Published to Intervals.icu**
only. Garmin Connect presence and physical watch inspection are separate manual
evidence. Never infer either from a 2xx response, a connection test, calendar
readback or a generated/downloadable FIT file.

## Mapping contract and compatibility scope

Call `mapWorkoutToIntervals` with a strict object containing `workout`,
`externalId`, `schedule: { localDate, timeZone }` and optional
`expandNestedRepeats`. The canonical definition is validated without mutation.
Provider routing, owner IDs, secrets and unknown properties are rejected.
`IntervalsWorkoutMappingError.issues` provides safe codes, paths and recovery
messages without echoing input values. No partial payload is returned on error.

The result declares `requirements.runPaceConfiguration`. RUN-41 calls
`prepareIntervalsWorkout(owner, input)` using its owner-authorized approved
definition. This validates the mapping and invokes owner-scoped configuration
preflight only for pace workouts. Its returned connection/credential nonce binding
is server-only: RUN-41 must check the same credential again immediately before
its calendar write. A replacement invalidates the preparation. Public routes
return only status, source and verification time, never credential bindings.
The older pure `assertIntervalsWorkoutConfiguration` remains available for
callers that already hold fresh settings; it does not provision or authorize.

After an Intervals.icu write, RUN-41 must call
`assertIntervalsWorkoutExport(approvedDefinition, fitBytes)` before marking the
prescription verified. It checks FIT integrity, executed repeat order, every
recovery, time/distance endings, free targets and absolute speed bounds. Only
1 mm/s encoding quantization is allowed; missing targets and provider widening
fail `PACE_TARGET_LOST`. This cannot establish watch receipt, and it cannot undo
provider forwarding that already occurred: RUN-41 must retain a truthful failed
or unverified publication state and recovery action.

A provider may widen a single-value pace using its configured Garmin tolerance.
Such widening of a canonical exact target is rejected by the export verifier;
explicitly prescribe an approved range instead of silently accepting different bounds.

## Selected delivery-reference policy — 2026-11-15

`pace-policy.ts` centrally defines reference version 1: **5:00/km = 1000/300 m/s**.
The verified compatible default boundaries are
`[77.5, 87.7, 94.3, 100, 103.4, 111.5, 999]` with the provider's seven default zone
names. These are delivery settings, not physiological measurements or training
recommendations. No history/race/easy-pace estimator is used.

- Valid existing Run threshold and zones: no PUT and no recalculation.
- Missing threshold with valid custom zones: PUT only `threshold_pace`.
- Missing zones with an existing threshold: PUT only default boundaries/names.
- Both absent: PUT the reference and verified default boundaries/names.
- Nonempty invalid boundaries, orphan custom names or ambiguous Run groups: stop
  with `CONFIGURATION_CONFLICT`, preserving the existing settings.

Zone compatibility requires 2–20 finite, positive, increasing boundaries ending
with the provider's `999` sentinel, with matching names when present. This is the
adapter's supported compatibility scope, not a claim about every provider format.
The write uses supported `PUT /api/v1/athlete/0/sport-settings/Run?recalcHrZones=false`;
readback verifies threshold float precision, boundaries, names and sport-group ID.
Other athlete settings are never included in the patch. OAuth would also need
the provider's [SETTINGS:WRITE permission](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/101);
the current implementation retains per-owner personal keys.

The checkpoint data type `INTERVALS_PACE_PREFLIGHT_V1` holds source
(`existing-user-configuration` or `technical-delivery-reference`), reference
version/value where applicable, fields provisioned, last verification, readback
and safe failure status. It is integration-only metadata under `src/server/intervals/`,
never an input to athlete analytics, training load, AI exports or plan generation.
The settings UI discloses that provider-side zones/load calculations may change.

A 90-second per-connection lease serializes application preparations. Short DB
transactions validate the current credential before saving intent, before PUT,
and before accepting readback; no network request runs inside a DB transaction.
Intent is saved before the external write so an ambiguous timeout can be
reconciled by a subsequent manual GET, rather than blindly repeating the PUT.
Credential replacement/disconnect clears readiness and leases. Technical reference
intent is retained separately as `INTERVALS_PACE_REFERENCE_V1:<Run settings ID>`
under the owner and connection, so rotating a key or reconnecting does not erase
the origin/version of settings left at the provider. A new preflight must read
the Run group through the current authenticated key and match both its provider
ID and effective threshold before reusing that provenance; another group or owner
cannot inherit it. These records contain no credentials and are removed with the
owner/connection. A later user change to the reference is preserved and classified
as existing configuration. Settings visits load local readiness on the server;
they never prepare delivery or call the provider automatically.

Current provider APIs expose no documented atomic compare-and-set for sport
settings. A fresh GET immediately before a minimal PUT detects observed edits;
readback detects unexpected results. A simultaneous external UI edit in the
remaining GET/PUT interval cannot be ruled out. Do not claim cross-system
transactional isolation or automatically roll back unknown user changes.

`GET /api/integrations/intervals/pace` reads only local status. Same-origin,
authenticated `POST` with an empty body or `{}` explicitly prepares delivery;
client owner/athlete/reference overrides are rejected. Read/write responses are
private/no-store. Permissions, rate limits, malformed/oversized responses,
timeouts, expired leases, replacement and ineffective readback fail closed with
safe recovery messages. Existing canonical targets are never stripped.

| Canonical input                | Provider text / behavior                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| RUNNING                        | `category: WORKOUT`, `type: Run`; other sports fail `UNSUPPORTED_SPORT`                                                               |
| Whole-second time              | `600s`                                                                                                                                |
| Whole-meter distance           | `400mtr`; `m` is minutes, never meters                                                                                                |
| Free target                    | Duration/distance with no target instruction                                                                                          |
| Pace range 240–270 seconds/km  | `4:30-4:00/km Pace`; explicit metric units, slow-to-fast provider ordering                                                            |
| Exact pace 305 seconds/km      | `5:05/km Pace`                                                                                                                        |
| Flat repeat                    | `3x` followed by its steps; blank lines terminate the repeat block                                                                    |
| Nested repeats                 | Rejected by default. Explicit `expandNestedRepeats: true` expands outer groups into flat blocks and returns `NESTED_REPEATS_EXPANDED` |
| Absolute BPM                   | `UNSUPPORTED_HEART_RATE`; never silently converted to HR zones, percentages or free targets                                           |
| Lap-only end                   | `UNSUPPORTED_LAP`; never invent an estimated duration/distance                                                                        |
| Fractional seconds/meters/pace | `UNSUPPORTED_PRECISION`; never rounded                                                                                                |
| Step cues                      | Letters/spaces without workout command words; otherwise `UNSUPPORTED_CUE`. Omit/rename the cue explicitly to retry                    |

The [workout builder guide](https://forum.intervals.icu/t/workout-builder/1163)
defines step lines, repeat blocks and HR targets relative to athlete settings.
The [official API schema](https://intervals.icu/api/v1/docs) includes the event-level
`target` selector. This adapter sets `target: PACE` explicitly, so provider sport
defaults cannot select power or HR instead. The provider's
[maintainer explains target selection](https://forum.intervals.icu/t/ictrainer-indoor-training-now-supports-hrm-mode/52531):
`AUTO` depends on the sport settings and a workout uses one selected target type.
[Absolute pace syntax](https://forum.intervals.icu/t/specify-workouts-using-absolute-pace/115846)
supports explicit `/km` units, avoiding dependence on display-unit preferences.
[Distance syntax](https://forum.intervals.icu/t/distanced-based-workouts-supported/9973)
supports `mtr`. Step cues pass through the provider's parser, so arbitrary
imported text cannot be inserted safely as commands. Event names remain separate
JSON fields.

**Concrete scope adjustment:** native nested loops are not supported by the text
builder according to its [maintainer](https://forum.intervals.icu/t/workout-builder/1163?page=9)
and the [current syntax guide](https://forum.intervals.icu/t/workout-builder-syntax-quick-guide/123701).
Expansion preserves all child executions, including every final recovery; it
does not preserve nested group presentation. Preview and approve this representation
before publishing. The local PoC budget is 50 rendered leaf steps plus repeat
markers, including expansion. Exceeding it returns `WORKOUT_TOO_LARGE` before
building an unbounded output. This is an application limit, not a claimed Garmin
hardware specification.

Absolute BPM is absent from the provider's documented HR text syntax; its
[BPM discussion](https://forum.intervals.icu/t/solved-write-min-and-max-heart-rate-in-workout/63267)
also records that limitation. The current canonical schema has no relative HR
target or athlete HR reference. This adapter therefore rejects BPM rather than
guessing percentages. Lap text examples use a numeric estimate and provider/device
semantics are not established for canonical lap-only input. A future verified FIT
adapter or explicit canonical contract change is required for those cases.

The all-capabilities RUN-28 `nestedIntervalsWorkout` fixture is intentionally
rejected: it contains BPM and lap-only steps. The separate synthetic
`intervalsWatchProbe` fixture covers the supported delivery scope. Unsupported
cases are test failures with actionable messages, not successful downgraded
workouts. Mixed pace/HR delivery is consequently outside this probe's scope.

## Schedule and update semantics

`schedule.localDate` must be a real `YYYY-MM-DD` date and `timeZone` an IANA zone
(UTC is accepted). The result retains both as local metadata. Only
`start_date_local: YYYY-MM-DDT00:00:00` is sent to Intervals.icu; no UTC suffix,
offset conversion, server-local date inference or invented training time is used.
This is a calendar-day mapping, not an instant. The app profile and provider
athlete time zones must agree; a changed provider time zone requires manual
rechecking. Dates spanning DST changes retain the selected day. Timed sessions,
ambiguous/repeated local hours and nonexistent DST hours are outside this contract.

The upload guide documents
`POST /api/v1/athlete/0/events/bulk?upsert=true` with an array of events and
calendar-write permission. Athlete `0` resolves from the owner's key/token; do
not accept another athlete ID from the browser. Use a durable scheduled-workout
identifier for `external_id` and keep it stable across retries, edits and date
changes. Do not derive it from mutable dates/content or make a new ID per attempt.
The provider matches external IDs within the creating application's context;
this is not a substitute for RUN-41's local owner checks and retry protections.
Verify behavior after credential/application changes rather than assuming
cross-application identity continuity.

For manual updates/rescheduling, send the full reviewed event with the same
external ID and changed content/date; confirm exactly one event remains on the
calendar. The documented cancellation call is
`PUT /api/v1/athlete/0/events/bulk-delete` with `[{ "external_id": "..." }]`.
Deleting or updating an Intervals.icu event does not prove that an already-synced
Garmin/watch copy changed. Preserve approved local revisions and completed history.

## User setup and physical Forerunner 165 procedure

1. Follow [RUN-39 account setup](intervals-workout-delivery.md). Connect and test
   the athlete's own key in Running Coach. The existing calendar-read test does
   not establish calendar-write permission or Garmin permissions. A second athlete
   must independently verify their own account; ADMIN never gains access to
   another owner's workouts or credentials.
2. In that athlete's Intervals.icu Garmin connection, authorize planned workout
   forwarding, enable **Upload planned workouts**, and include Running in sport
   filters. Confirm the Garmin Connect account and Forerunner 165 belong to the
   same athlete. The server must check Run pace configuration before publishing;
   the athlete is not expected to know or manually enter threshold pace.
   Matching zone labels alone is not evidence of matching watch targets. A
   fixed delivery reference is configured automatically only where required,
   under the policy above. It is not an athlete measurement. Select **Prepare
   workout delivery** to check/configure settings and recover before publication.
3. Copy [the synthetic probe payload](fixtures/intervals-workout-probe.json) to a
   private local file. Change only its schedule to a chosen upcoming local day
   within the provider's forwarding window. The committed date is an example,
   never a live scheduling instruction. Review the canonical fixture and expanded
   text. Explicitly approve this synthetic probe before any manual API write.
4. With an authenticated HTTP client, intentionally POST that array to the bulk
   upsert endpoint above using **your own** key/token. Keep credentials in the
   client's secret storage; never save them in the payload, Git, screenshots or
   exported results. This manual test write is separate from app import/approval.
   Use only calendar endpoints, never Activity/Health endpoints.
5. Inspect the Intervals.icu calendar event and structured preview. Expect warmup
   600 seconds; two sets, each containing **three** 400-meter pace intervals at
   4:00–4:30/km, each followed by 90 seconds free recovery; 180 seconds free
   recovery after **each** set; cooldown 300 seconds. That is six work intervals,
   six short recoveries, two set recoveries and 16 executed leaf steps in total.
   Verify a free step has no target; an exact pace may gain a device tolerance.
6. Inspect the same workout in Garmin Connect, then synchronize the physical
   Forerunner 165. Open the scheduled workout on the watch and inspect its date,
   repeats, recovery counts, step endings, pace target type and bounds. Start a
   harmless preview only when appropriate. Record watch firmware, local date/zone,
   expected/observed structure and separate timestamps for each delivery stage.
   A supported text fixture is not proof of watch compatibility.
7. Repeat the POST unchanged; confirm the same Intervals.icu event ID and no
   duplicate. Change a pace band in a **test copy**, upsert with the same external
   ID, and inspect the change through all three stages. Reschedule the same event
   to another upcoming day and check old/new calendar dates and watch copies.
   Test local dates around the athlete's DST transition when feasible. Cancel the
   synthetic event explicitly and verify cleanup at each stage.

Intervals.icu's [Garmin forwarding guide](https://forum.intervals.icu/t/upload-planned-workouts-to-garmin-connect/1521)
describes provider-managed forwarding, with a roughly next-seven-days window
documented in the [later discussion](https://forum.intervals.icu/t/upload-planned-workouts-to-garmin-connect/1521?page=10).
Far-future events may wait. That provider behavior starts no Running Coach
background work. Garmin Personal API remains **manual inbound Activities/Health
only**, never a planned-workout write API. No automatic Garmin sync is triggered.

## Failures and manual recovery

### Submit the reviewed probe from PowerShell

Run from the repository root after reviewing the synthetic payload. Choose an
upcoming date in your provider athlete's local calendar (within seven days).
The key is entered with hidden input and kept only in process memory. This
performs one explicit calendar write; it has no automatic retry. Success prints
only the event ID, name and local date, not credentials or the raw response.

```powershell
[object[]]$probeEvents = ConvertFrom-Json -InputObject (
  Get-Content -LiteralPath 'docs/fixtures/intervals-workout-probe.json' -Raw
)
$probeDate = Read-Host 'Probe local date (YYYY-MM-DD)'
[datetime]::ParseExact($probeDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) | Out-Null
$probeEvents[0].start_date_local = "${probeDate}T00:00:00"
$probeBody = ConvertTo-Json -InputObject $probeEvents -Depth 10

$probeSecret = Read-Host 'Intervals.icu API key' -AsSecureString
$probeCredential = [PSCredential]::new('API_KEY', $probeSecret)
$probeAuth = [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes(
    'API_KEY:' + $probeCredential.GetNetworkCredential().Password
  )
)

try {
  [object[]]$probeSettings = Invoke-RestMethod `
    -Method Get `
    -Uri 'https://intervals.icu/api/v1/athlete/0/sport-settings' `
    -Headers @{ Authorization = "Basic $probeAuth" } `
    -TimeoutSec 20
  $probeRunSettings = @($probeSettings | Where-Object { $_.types -contains 'Run' })
  if ($probeRunSettings.Count -ne 1 -or
      $probeRunSettings[0].threshold_pace -le 0 -or
      $probeRunSettings[0].pace_zones.Count -eq 0) {
    Write-Host 'Pace delivery unavailable: provider Run configuration is missing. No workout sent.'
    return
  }
  $probeResult = Invoke-RestMethod `
    -Method Post `
    -Uri 'https://intervals.icu/api/v1/athlete/0/events/bulk?upsert=true' `
    -Headers @{ Authorization = "Basic $probeAuth" } `
    -ContentType 'application/json' `
    -Body $probeBody `
    -TimeoutSec 20

  $probeResult | Select-Object id, name, start_date_local
} catch {
  $probeFailure = $_
  Write-Host 'Request failed. Check the Intervals.icu calendar before retrying.'
  if ($null -ne $_.Exception.Response) {
    Write-Host ('HTTP {0}' -f [int]$_.Exception.Response.StatusCode)
  }
} finally {
  $probeAuth = $null
  $probeCredential = $null
  $probeSecret.Dispose()
}
```

### Reconcile failures

- Mapping error: inspect its code/path; edit the workout explicitly, or use the
  supported probe. Do not strip targets, change end conditions or trim recoveries
  automatically. Read and acknowledge expansion warnings before publishing.
- Rejected key or insufficient permission: replace/test the owner's key through
  RUN-39; verify write permission separately. Never retry with another user's key.
- Timeout, 429 or provider outage: delivery is unknown until a calendar readback
  reconciles the stable external ID. Do not blindly create a new ID. RUN-41 must
  persist and reconcile ambiguous writes; this mapper performs no retry.
- Event accepted but absent in Garmin: check the correct account, permission,
  toggle, sport filter and date window in Intervals.icu. Then sync Garmin Connect.
- Garmin Connect shows the workout but watch does not: sync the watch, inspect
  device compatibility and calendar, and check for old copies after a move/edit.
  Remove only known synthetic stale copies manually after confirming their identity.
- Missing pace target: review the athlete's real Run pace configuration and the
  exported/Connect preview before retrying. Recheck on the physical device; never
  call it delivered based on parsing alone. Provider/account/device changes can
  invalidate previously observed behavior.

An [independent integration report](https://forum.intervals.icu/t/pace-targets-lost-in-garmin-export-for-api-created-running-workouts-steps-arrive-on-watch-as-no-target-parsed-correctly-in-workout-doc/130706)
records missing Run threshold pace as a cause of lost watch targets and reports
needing delete/recreate after correcting settings. This is a reported recovery,
not verified behavior for this app. Reconcile the existing event before any
explicit synthetic delete/recreate and check both calendars for stale copies.

## Results log — 2026-11-15

Initial mapping checks, before the automatic provisioning extension:
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`
and `pnpm build` passed. That suite finished with 1,226 passed and 108 skipped
tests, including 62 mapper/pure-preflight tests. The first full run timed out in an existing
Prisma configuration test; that test passed alone and on the subsequent full run.
Guarded database/live-provider suites were skipped; no schema or migration changed.

The initial manual PowerShell example incorrectly wrapped the parsed JSON array
on Windows PowerShell, causing HTTP 422 `start_date_local is required`. The
corrected example uses an explicitly typed array. Its JSON roundtrip and script
syntax were checked locally, and the agent subsequently performed the live
requests using the explicitly authorized environment credential without printing
it or retaining it in fixtures.

Live evidence:

- The structured text probe was created for local date 2026-11-16 and read back
  with matching description, sport, date and `PACE` selector. The provider compiled
  both groups of three 400-meter intervals with the 240–270 seconds/km range,
  90-second recoveries and both 180-second set recoveries.
- An unchanged bulk upsert retained the provider event ID; calendar readback
  contained exactly one probe. No duplicate was created.
- With missing Run threshold and pace zones, provider FIT export contained ten
  encoded steps (including two repeat markers) with correct timing/distance, but
  both work-step targets were `open`. The user confirmed the correct 2026-11-16
  date, two groups of three repeats, and 90/180-second recoveries on the physical
  Forerunner 165, and confirmed `No Target/Open` instead of pace.
- An auxiliary supported FIT-upload experiment started with an independently
  decoded 400-meter step with absolute speed bounds 3.704–4.167 m/s. Intervals.icu
  converted it into relative pace text, and its exported FIT again had an open
  target. FIT upload therefore did not bypass the missing configuration. This
  matches the provider maintainer's
  [description of FIT target conversion](https://forum.intervals.icu/t/import-workouts-from-fit-file-does-not-work-with-absolute-hr-or-pace/92909).
- The user explicitly authorized an arbitrary value for API testing. Original
  pace settings were captured in memory; only then was a temporary 6:00/km
  reference applied. Intervals.icu populated default zones automatically. This
  value is synthetic test configuration, not a measured or estimated athlete
  threshold. The updated main probe's decoded FIT then contained speed targets
  rounding to exactly 4:00–4:30/km, with free recoveries and repeat counts preserved.
  The user then confirmed on the physical Forerunner 165 that the updated pace
  targets and the complete repeat/recovery structure were correct. This verifies
  delivery with that explicitly authorized temporary test configuration only.
- On the auxiliary synthetic event, changing the pace band to 4:10–4:40/km and
  rescheduling 2026-11-16 to 2026-11-17 retained the same event ID and exactly one
  calendar record. Explicit bulk cancellation removed that auxiliary probe;
  readback confirmed removal and preservation of the main watch probe. These
  API checks do not prove downstream update/reschedule/cancel propagation.

After confirmation, both synthetic calendar events were deleted and readback
confirmed their absence. The provider ignored `null` fields when restoring
settings, and rejected an empty pace-zone array with HTTP 422 `Invalid pace zones`.
Setting `threshold_pace: 0` cleared the test reference back to `null`; it is not
left as an athlete measurement. **Residual provider-side change:** automatically
created standard seven-zone percentages and names remain. Exact restoration of
the originally null zone definitions was not achieved through the documented
update API. No sport setting was deleted or replaced wholesale to force cleanup.
Removing the calendar events does not prove that Garmin removed every cached
library/watch copy; downstream cleanup was not manually verified.

This historical arbitrary reference was only an authorized experiment. The
updated policy below selects one validated, versioned delivery-only reference;
it is never presented as a real athlete measurement.

| Scenario                                                    | Local evidence                                          | Live Intervals.icu / Garmin / Forerunner 165                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Supported probe and nested expansion                        | Exact payload/sequence tests; immutable canonical input | Calendar compilation verified; user confirmed device date and repeat/recovery structure                                                  |
| Pace range, metric distance and free target                 | Exact text tests plus configuration preflight           | No Target reproduced without configuration; correct FIT and physical watch pace targets confirmed with an authorized temporary reference |
| BPM, lap-only, fractional values, unsafe cues, other sports | Actionable rejection tests                              | Unsupported uploads not attempted                                                                                                        |
| Stable ID on retry/content/date change                      | Mapping tests                                           | Same event ID and one calendar record after retry, update and reschedule                                                                 |
| Explicit cancellation                                       | Documented provider contract                            | Both synthetic probes absent after cleanup; downstream cancellation not verified                                                         |
| DST, malformed input and size budget                        | Validation/date tests                                   | Live DST/provider-zone changes not tested                                                                                                |
| Owner account, Garmin permission and upload toggle          | Existing RUN-39 behavior retained                       | Authorized key accepted writes; user confirmed Connect/watch receipt for this account; second athlete not tested                         |

Orbit discovery returned no relevant contract and the Postman CLI was unavailable;
primary provider documentation above and explicitly authorized live probes were
used. Physical date, repeat/recovery structure and pace targets were confirmed
by the user. The updated RUN-40 decision rejects manual input and implements the
fixed delivery-only reference rather than estimating physiological thresholds.
Do not advertise general device compatibility or production readiness from this
single-account proof. No Garmin Personal API request or inbound sync was triggered.

## Fixed-reference implementation verification — 2026-11-15

- The explicitly gated `pace-delivery.live.test.ts` executed real provider
  requests through the implemented settings client. With references 5:00/km
  and 6:00/km, all four absolute bands 3:30–4:00, 4:00–4:30, 5:30–6:00 and
  7:00–7:30/km survived FIT export verification, including mixed time/distance
  endings. The same stable calendar event ID was retained.
- The representative `intervalsPaceReferenceProbe` uses two outer sets, each
  containing two repeats of 400 m at 4:00–4:30/km, 30 s free recovery, 60 s at
  5:30–6:00/km, and 30 s free recovery, followed by 60 s set recovery. Warmup and
  cooldown are each 60 s free. The mapper explicitly expands outer nesting.
- With version-1 reference 5:00/km and compatible default zones, the exported
  FIT preserved all twenty executed leaves, targets and repeat semantics.
  The user confirmed **both target bands, date 2026-11-16 and the full structure
  on the real Forerunner 165** after Garmin Connect synchronization. Firmware
  version was not supplied. This is bounded device evidence, not universal
  compatibility with all devices/paces/zone formats.
- The synthetic reference event was removed after confirmation. Readback
  confirmed absence, restoration of the previously missing threshold using
  the provider's zero-clear convention, and unchanged pre-existing zone
  definitions. No additional zone cleanup was needed in this second experiment.
- `pnpm db:assert:development` passed before database tests. `pnpm test:db`
  passed 105 tests on the marked development database. The new PostgreSQL case
  covers two USER/ADMIN owners, encrypted credentials, separate provenance
  checkpoints, preserving existing settings, and invalidating readiness while
  retaining group-bound provenance on key replacement/disconnect. Provider responses are synthetic in DB tests;
  live capability checks use only the separately authorized personal account.
- HTTP stand-in tests exercise actual request serialization and timeout.
  Unit/route/browser cases cover permission failures, readback failure, invalid
  partial settings, lost targets, leases, stale credentials and safe recovery UI.
  Postman CLI was unavailable; no Postman simulation run is claimed.

The live probe is disabled during ordinary tests and never loads live keys
unless `RUN40_INTERVALS_LIVE_PROBE=1`. To rerun deliberately, set
`RUN40_PROBE_DATE` to the chosen local `YYYY-MM-DD` and run
`pnpm exec vitest run src/server/intervals/pace-delivery.live.test.ts`.
The authorized account must start with a missing threshold and compatible zones;
an existing user threshold is never replaced just to run the test. By default
the test cleans up its event and restores the missing threshold. Set
`RUN40_KEEP_WATCH_PROBE=1` only for physical verification, then explicitly remove
the namespaced synthetic event and restore the captured original settings.

No schema change/migration or new worker is required. RUN-41 still owns approved
record authorization, the explicit calendar write/outbox, credential-binding
revalidation, export verification, truthful publication status and retry recovery.
No threshold estimation, automatic inbound Garmin sync or automatic publication
has been introduced.

Final checks for this extension: `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm build` and `pnpm build-storybook` passed. The first
unlimited-worker `pnpm test` run hit the pre-existing Prisma configuration import
timeout; the complete repeat with `pnpm test --maxWorkers=2` passed **1,314 tests**
with 111 guarded tests skipped. Database tests were also run explicitly:
`pnpm test:db` passed 105 tests. The two explicitly authorized live delivery tests
passed separately, followed by the physical confirmation and cleanup above.
Storybook emitted nonblocking Vite directive/sourcemap and chunk-size warnings.
The final browser regression run passed all 15 Intervals connection UI tests.
