# ADR-002: Garmin access research for RUN-22

**Status:** Provisional BYOK decision; isolated API PoC verified. Updated
2026-11-08 for RUN-22.

## Decision for the current product

The project owner reports that Garmin confirmed by email that this small,
private, invite-only Running Coach application may use the Personal API with
individual user-owned keys (BYOK). **This is user-reported approval:** the email,
its exact wording, scope, conditions and expiry were not available to verify.
Record them before enabling the shared hosted connector. Direct Garmin access
is the preferred architecture, with one key per athlete in the existing RUN-21
encrypted credential vault and all reads scoped to that verified athlete.
Intervals.icu is a separate optional integration.

The public FAQ alone does not establish permission for this shared deployment:
Garmin describes Personal API access as access to an individual's **own** data
and directs organizations building integrations for multiple users to its
business program. The reported email may provide the project-specific exception
or clarification; retain the exact evidence when available.
[Garmin Personal API FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/),
[Garmin developer program overview](https://developer.garmin.com/gc-developer-program).

The isolated PoC is separate from production synchronization. It can be run
locally with the owner's key to verify technical behavior. It has no scheduler,
production route or persistent Garmin data storage. A local live probe of one
user-owned key succeeded on 2026-11-08; see the exact evidence below.

## Evidence and limits

| Question                  | Verified public evidence                                                                                                                                                                                                                                                                                                                             | What remains unverified                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal API rights       | Garmin says the Personal API is for individual users accessing their own data; its developer program is for integrations serving multiple users. [FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)                                                                                                                     | Project owner reports email approval for this BYOK app. Exact text, conditions and duration still need verification.                                                                                                                                                                        |
| Key lifecycle             | Users generate their own key in Garmin Connect, choose 30, 90, 180 days or one year, and see it only once. Deletion invalidates the key and associated tokens. [FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)                                                                                                       | Exact response and error bodies, warning behavior, and rotation behavior on a live account.                                                                                                                                                                                                 |
| Token lifecycle           | Exchange a key at `POST /personalapitoken-service/personal-api/personal-api-key/token` using `Authorization: ApiKey ...`. Access tokens last 24 hours or until key expiry, whichever is sooner; there is no refresh token. A new token can be obtained with the key. [FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/) | Live expiry, revocation and concurrent exchange behavior. The key is the long-lived secret; a new token exchange is not a refresh-token flow.                                                                                                                                               |
| Delivery and data classes | Garmin lists Personal access as pull-only Activity JSON/FIT, Health JSON, and Women's Health JSON. [Program overview](https://developer.garmin.com/gc-developer-program)                                                                                                                                                                             | This PoC verified selected activity and health JSON reads plus one FIT activity download on one account. Women's Health was not tested.                                                                                                                                                     |
| Historical access         | Garmin's own client exposes date-range reads and paginated activity search. [Official client endpoint table](https://github.com/garmin/connect-personal-api-python#endpoint-wrappers)                                                                                                                                                                | A guaranteed lookback period, maximum date window, backfill completeness and pagination behavior. A bounded older running search returned 200 with no match; that does not establish a historical boundary. Do not apply Business Starter/Enterprise historical-data rules to Personal API. |
| Rate limits               | No numeric Personal API quota or retry contract was found in the public FAQ, overview or official client README. [FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/), [official client](https://github.com/garmin/connect-personal-api-python)                                                                           | Numeric quota, limit scope, response headers, `429`/`Retry-After` behavior and safe backfill pace. No rate limit was intentionally approached.                                                                                                                                              |

### Endpoint and field inventory

Garmin's [official Python client](https://github.com/garmin/connect-personal-api-python#endpoint-wrappers)
lists the routes below. The live results are from a single local account and
date window, not a guarantee for other accounts or devices.

| Data needed by Running Coach        | Documented Personal API request                                                                                                                                                                           | Live response fields verified here                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Activities and history              | `GET /activitylist-service/activities/search/activities` with `start`, `limit`, optional dates/type; `GET /activity-service/activity/{activity_id}`; `GET /download-service/files/activity/{activity_id}` | Search, detail and FIT download returned 200. One ZIP decoded with valid FIT integrity, session and lap messages. |
| Daily summaries, steps, stress      | `GET /usersummary-service/v2/dailysummaries`; `GET /usersummary-service/stats/steps/daily/{start_date}/{end_date}`; corresponding `stress` path                                                           | Daily summaries returned 200; separate steps/stress routes not tested.                                            |
| Sleep, resting heart rate candidate | `GET /sleep-service/sleep/dailySleep`; `GET /sleep-service/sleep/dailySleepSummariesByDate`; `GET /wellness-service/wellness/dailyHeartRate`                                                              | Daily sleep returned 200. Daily summary `heartRate.restingValue` was numeric on the sampled day.                  |
| HRV, Body Battery                   | `GET /hrv-service/hrv/{calendar_date}`; `GET /hrv-service/hrv/daily/{start_date}/{end_date}`; `GET /wellness-service/wellness/bodyBattery/reports/daily`                                                  | Single-day HRV and Body Battery returned 200; range HRV not tested.                                               |
| Weight, profile, other health       | `GET /weight-service/weight/range/{start_date}/{end_date}`; `GET /userprofile-service/userprofile/settings`; client also lists hydration, SpO2 and women's health reads                                   | Not tested.                                                                                                       |

The client lists routes, not a stable promise that a user's response contains
every metric in our database design. The public
[Personal Swagger page](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
embeds an OpenAPI 3.0.1 document; its schema descriptions are cited separately
from live observations below. Do not infer FIT content from JSON route names.

## Fallback and product impact

Direct Garmin access is preferred under the reported BYOK approval. A manual
file import still matters for outages, expired keys and any limits in the
approval; it is not replaced by Intervals.icu.

Garmin [documents exports](https://support.garmin.com/en-SG/?faq=W1TvTPW8JZ6LfJSfK512Q8)
of individual activities in original format (usually FIT), activity-list CSV,
account-wide archives, and per-day wellness FIT archives. These are credible
user-controlled input sources for a file importer. The Running Coach repository
currently has an encrypted provider-credential vault but no activity/FIT/CSV
import implementation. Thus the RUN-22 fallback **does not yet work**; it is
still an implementation and real-file validation task.

Do not assume Intervals.icu can supply Garmin-sourced data as a fallback. Its
[API maintainer warned in October 2026](https://forum.intervals.icu/t/api-access-to-intervals-icu/609/1)
that Garmin terms may require blocking Garmin data through the Intervals API.
That statement is a risk signal, not proof that all such reads are already
blocked. Intervals remains a separate potential workout-publication channel;
its Garmin data-read permissions need their own confirmation.

Prioritize a user-uploaded activity FIT import for completed runs. Add wellness
imports only after inspecting actual Garmin export samples and defining fields,
units, provenance, retention and deduplication. Keep every imported record
owner-scoped; validate file type/content and map into canonical records. Never
use another athlete's records as a PoC fixture. See the project's
[System Architecture](../system-architecture.md) and
[Database Design](../database-design.md).

## Evidence required before closing RUN-22

1. Verify and retain Garmin's reported email approval for this hosted
   invite-only BYOK model. Capture its exact conditions and duration without
   copying account credentials. Keep the shared connector gated until then.
2. In a permitted isolated account, record date, device type, exact endpoint,
   query window, status, redacted response shape, field names, units, timezone,
   empty/null cases, and observed historical boundary. Test key expiry,
   replacement, revocation and token exchange without publishing credentials.
3. Ask Garmin for numeric Personal API limits, or measure conservatively in a
   permitted context. Record response headers and `429` behavior; do not
   manufacture a quota from unrelated Garmin APIs.
4. Implement and verify one owner-scoped fallback import with a real user
   export held privately and synthetic regression fixtures in the repository.
   Test duplicate import and a different user's access. Do not expose raw FIT,
   GPS, credentials or health data in logs, PR artifacts or AI exports.

## Isolated PoC implementation and live evidence

`src/server/garmin/personal-api-poc.ts` uses the RUN-21 vault for authenticated
owner-scoped calls (`readProviderApiKey(owner, 'GARMIN')`). The explicit local
live test reads `GARMIN_API_KEY` from the saved root `.env` without storing that
key in another system. It exchanges the key, fetches at most three activity
summaries, fetches at most one activity detail and makes one exploratory laps
read, then samples daily summaries,
sleep, HRV and Body Battery for one UTC date. Each request has an eight-second
timeout, a one-second gap, no retry, no redirect, no cache and a 512 KiB JSON
body cap. A `429` stops the sequence. The report contains only endpoint names,
HTTP statuses and bounded JSON field paths/types. It never prints raw values,
activity IDs, GPS, keys or tokens.

Run deliberately with `GARMIN_LIVE_POC=1 pnpm exec vitest run
src/server/garmin/personal-api-poc.live.test.ts` after saving a personal key as
`GARMIN_API_KEY` in the repository-root `.env`. On PowerShell, set the flag with
`$env:GARMIN_LIVE_POC='1'` before running `pnpm exec vitest run
src/server/garmin/personal-api-poc.live.test.ts`. Run only against the key
owner's own account in a permitted local context. Do not attach raw output or
response bodies to the issue; transcribe non-sensitive schema findings here.

### Live observations, 2026-11-08

The owner supplied a Personal API key in the ignored local `.env`. The PoC made
read-only requests to `personal.connectapi.garmin.com`, with `start=0`,
`limit=3`, activity search dates `2026-10-08` through `2026-11-06` UTC, and
health date `2026-11-06` UTC. No raw response, activity ID, location, health
value, token or key was saved. The first token attempt returned **406** because
the PoC incorrectly requested JSON. Garmin's
[official authenticator](https://github.com/garmin/connect-personal-api-python/blob/main/src/garmin_personal_api/auth.py)
sends `Accept: */*` and reads the response as plain JWT text. With that
correction, token exchange returned **200** and all subsequent reads below
were made with the bearer token.

| Request                                                    | HTTP | Structure observed without values                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /activitylist-service/activities/search/activities`   | 200  | Array of activity objects. The sampled object had `activityId`, `activityType`, `startTimeLocal`, `startTimeGMT`, `distance`, `duration`, `elapsedDuration`, `movingDuration`, `averageSpeed`, `averageHR`, `averageRunningCadenceInStepsPerMinute`, `elevationGain`, `lapCount`, `beginTimestamp`, and location/owner fields. |
| `GET /activity-service/activity/{id}`                      | 200  | Object with `activityId`, `activityUUID`, `activityTypeDTO`, `timeZoneUnitDTO.timeZone`, `metadataDTO` and `summaryDTO`. `summaryDTO` had the corresponding activity time, distance, duration, speed, heart-rate, cadence and elevation fields. `metadataDTO.lapCount` was numeric.                                            |
| Exploratory `GET /activity-service/activity/{id}/laps`     | 404  | This path is not in Garmin's official Personal client endpoint list. The 404 confirms it did not yield laps in this account/context; do not build RUN-23 on it.                                                                                                                                                                |
| `GET /usersummary-service/v2/dailysummaries`               | 200  | Object with `data[]`; each sampled day had `calendarDate`, `heartRate`, `stress`, `bodyBattery`, `movement`, `calories`, `hydration`, `respiration` and other sections. Nested `heartRate` fields were beyond the PoC's shape-depth cap, so resting HR itself is **not yet verified**.                                         |
| `GET /sleep-service/sleep/dailySleep`                      | 200  | Object with `calendarDate`, `sleepTimeSeconds`, `napTimeSeconds`, sleep-stage seconds, numeric `sleepStartTimestampGMT`/`Local`, `sleepScores` and other metrics. In the sampled first response, `averageSpO2Value`, `lowestSpO2Value`, `highestSpO2Value` and several sleep-quality fields were `null`.                       |
| `GET /hrv-service/hrv/{date}`                              | 200  | Object with `hrvSummary.lastNightAvg`, `weeklyAvg`, baseline and status; `hrvReadings[]` had `hrvValue` and GMT/local reading-time strings. GMT/local start and end strings were present.                                                                                                                                      |
| `GET /wellness-service/wellness/bodyBattery/reports/daily` | 200  | Array of daily objects with `date`, `charged`, `drained`, `bodyBatteryValuesArray`, descriptors and GMT/local reporting-window strings.                                                                                                                                                                                        |

Only one first activity and one first day were used to summarize field types;
absence from this table is **not** evidence that a field is unavailable. An HTTP
200 proves the request succeeded, not that every expected metric is present or
correct for every date. The initial PoC did not inspect account/device identity, older
history, pagination, rate-limit headers, FIT files, token expiry or revocation.
The official Personal API's `/laps` availability remains unresolved beyond this
one 404. The FIT download was tested in the follow-up below.

### Bounded contract follow-up, 2026-11-08

The isolated `probeGarminDataContracts` path reused the same key exchange and
read-only endpoints. The authenticated owner wrapper reads the key from the
RUN-21 vault; this explicit local test used the owner's ignored `.env` key and
did not create a new credential store. It made eight requests total: token,
one recent activity search (`limit=1`), one documented FIT download, four
health reads for `2026-11-06` UTC, and one older running search (`limit=1`,
`2026-07-10` through `2026-09-08` UTC). Each call used the existing eight-second
timeout and one-second gap, with no retry. JSON was capped at 512 KiB; the FIT
download and in-memory decompression were each capped at 8 MiB. No raw FIT,
response values, IDs, locations, token or key were written to disk or printed.
Run only when needed with `GARMIN_CONTRACT_POC=1 pnpm exec vitest run
src/server/garmin/personal-api-contract-poc.live.test.ts` (set the environment
flag separately in PowerShell).

| Request                                                                            | HTTP | Verified structural finding                                                                                                                                                                                                                                                                                                                                                                                                   | Limit                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /download-service/files/activity/{id}`                                        | 200  | Response was a ZIP containing a FIT file. Garmin's official JavaScript FIT SDK passed the integrity check and decoded without errors. Session and Lap messages were present; decoded Lap count matched the activity summary's `lapCount` for this sample. Lap fields included `startTime`, `timestamp`, `totalElapsedTime`, `totalTimerTime`, `totalDistance`, `avgHeartRate`, `avgCadence`, `lapTrigger` and `messageIndex`. | One activity only. A FIT Lap represents a lap/interval; this does not prove an exact correspondence to every user-visible split or to all activity types. Segment Lap messages were absent in this sample.                            |
| `GET /usersummary-service/v2/dailysummaries`                                       | 200  | Nested `heartRate` keys were `minValue`, `maxValue`, `restingValue`; `restingValue` was numeric on the sampled day.                                                                                                                                                                                                                                                                                                           | Other days/devices may omit or null it. Do not use an imagined `restingHeartRate` key.                                                                                                                                                |
| `GET /sleep-service/sleep/dailySleep`                                              | 200  | `sleepStartTimestampGMT` and `sleepStartTimestampLocal` were numbers. The GMT number was plausible Unix epoch **milliseconds**; local minus GMT was an integral minute offset within 14 hours.                                                                                                                                                                                                                                | This supports the numeric millisecond interpretation for this sample, despite Swagger's `string`/`date-time` type. The offset's IANA zone, daylight-saving behavior, end timestamps and other devices were not independently checked. |
| `GET /hrv-service/hrv/{date}`                                                      | 200  | `hrvSummary.lastNightAvg` was numeric; `hrvReadings[]` had `hrvValue`, `readingTimeGMT`, `readingTimeLocal`.                                                                                                                                                                                                                                                                                                                  | This establishes shape and type, **not** the Personal API fields' units; retain unit as unresolved until an explicit schema statement or provider confirmation.                                                                       |
| `GET /wellness-service/wellness/bodyBattery/reports/daily`                         | 200  | `bodyBatteryValueDescriptorDTOList[]` entries had `bodyBatteryValueDescriptorIndex` and `bodyBatteryValueDescriptorKey`. `bodyBatteryValuesArray[]` contained arrays of two numbers; descriptor count matched row width.                                                                                                                                                                                                      | Descriptor key values and column meanings were deliberately not logged. Establish the index-to-column map and timestamp semantics before normalizing samples.                                                                         |
| `GET /activitylist-service/activities/search/activities` with older running window | 200  | No matching running activity was returned.                                                                                                                                                                                                                                                                                                                                                                                    | An empty bounded search cannot distinguish no runs from a history cutoff or filtering issue. No historical reach is claimed.                                                                                                          |

Garmin's [FIT Activity File guide](https://developer.garmin.com/fit/articles/file-types/activity.html)
describes Lap messages as laps or intervals and notes that device/sport features
affect available fields. Its [decoding guide](https://developer.garmin.com/fit/articles/cookbook/decoding_activity_files.html)
recommends surveying multiple files and sorting summaries by start time rather
than message order. The PoC established a usable lap extraction path, while
RUN-23 should keep lap support optional until more private samples are tested.

### Units and timezones

These are **schema statements**, not values inferred from the sampled athlete.
Garmin's [Personal Swagger reference](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
describes activity `distance` and elevation in meters, durations in seconds,
speed in meters/second, heart rate in beats/minute, running cadence in
steps/minute, and `beginTimestamp` as Unix epoch milliseconds. It describes
`sleepTimeSeconds` and sleep-stage durations in seconds, and `charged`/`drained`
on the 0–100 Body Battery scale. Garmin's general
[HRV explanation](https://www.garmin.com/en-IE/garmin-technology/health-science/hrv-status/)
uses milliseconds, but the Personal schema does not explicitly state a unit
for `hrvSummary.lastNightAvg` or `hrvReadings[].hrvValue`; confirm those fields
before normalizing them as milliseconds.

The Swagger schema says activity `startTimeGMT` represents UTC and
`startTimeLocal` represents local time, but **both omit an offset and `Z`**.
The detail response has an IANA `timeZoneUnitDTO.timeZone` string. The PoC
observed all three field types but did not log their values or verify their
mutual consistency. Sleep start/end timestamps were numeric in the live
response, while the Swagger schema labels them `string`/`date-time` and
describes milliseconds. The follow-up found an epoch-millisecond-plausible GMT
value and a minute-aligned local/GMT difference on one day. Treat the type
discrepancy as unresolved across devices; preserve GMT as the instant and
verify the local-zone relationship before mapping into `timestamptz`.
HRV and Body Battery also expose separate GMT/local timestamp strings without
offsets. Never parse a local timestamp as UTC merely because it resembles ISO 8601.

## Handoff to RUN-23

RUN-23 defines one canonical activity and health shape across Garmin,
Intervals.icu and manual sources. The observed Garmin candidate fields are
`activityId`/`activityUUID` for source identity, `activityTypeDTO`,
`summaryDTO` distance/duration/speed/HR/cadence/elevation, and
`timeZoneUnitDTO.timeZone` plus GMT/local start strings. Map seconds to the
database's milliseconds and preserve canonical meters and m/s explicitly.
The documented FIT download yielded valid Lap messages for one activity; treat
laps as optional and verify mapping across more activity types and devices.
The exploratory JSON `/laps` path returned 404. Map the observed numeric
`heartRate.restingValue` as a nullable resting-HR candidate. Parse sleep GMT
timestamps as milliseconds only after runtime type/range validation and keep
local timestamps as local context. HRV values were numeric but their Personal
API units remain unverified; keep HRV unit/mapping unresolved. Body Battery
samples use descriptor-indexed numeric rows; defer column and timestamp mapping
until descriptor meanings are verified. Historical lookback remains unknown
because the bounded older search was empty. Preserve source/provider and
per-owner external IDs, use nullable
values for absent metrics, and define cross-provider duplicate policy. A `null`
SpO2 or missing metric must never become zero.
See [RUN-23](https://linear.app/fr-running-coach/issue/RUN-23/define-provider-neutral-activity-and-health-normalization).

**RUN-22 acceptance state on 2026-11-08:** BYOK rights are user-reported but
not independently verified; isolated live token, activity, FIT Lap and health
reads succeeded; a JSON laps candidate returned 404; historical reach and HRV
units remain unresolved; fallback import remains
unimplemented. The issue remains open.
