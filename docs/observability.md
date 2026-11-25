# Operational observability (RUN-53)

Open **Admin → Operational health** or authenticated `GET /api/admin/operations`.
An active ADMIN session is required, including on the service itself; anonymous
requests get 401 and another USER gets 403. Responses use `private, no-store`.
Reload the page to refresh. An unavailable report returns 503, never an empty
healthy report. This is operational access, not access to another athlete's data.

The report contains only:

- Failure code/count totals for sync requests started within the last 24 hours,
  including successful requests with partial errors. Counts describe requests,
  not distinct athletes or unrecovered incidents.
  `PARTIAL_IMPORT` includes completed health-date batches and FIT backfills with
  retained item failures. They keep their normal success/retry semantics while
  recording a safe operational warning; successful retries have no partial code
  once the relevant failures are cleared. Earlier request warnings remain in the
  24-hour history. Unavailable optional FITs alone are not classified as failures.
- Current failed, uncertain or superseded publication intents, without a time
  cutoff so an old unresolved publication does not disappear.
- RUNNING sync requests and QUEUED/RUNNING publications older than five minutes.
  These are investigation signals, not proof that a remote write failed.

Queries aggregate operational tables without selecting health rows, owner IDs,
job names, checkpoint JSON, record counts, athlete IDs or workout payloads.
Persisted error strings are untrusted: only fixed known codes and constrained
HTTP/error categories are returned; everything else becomes `UNKNOWN_ERROR`.
There are no owner filters, incident drilldowns or admin retry controls.

## Scrubbed application logs

Handled failures in Garmin activity sync, health sync, historical/data/FIT import and
Intervals publication emit one JSON warning through
`src/server/observability/events.ts`. Each contains `event=operation_failed`, an
independent random event ID, fixed operation name and allowlisted error code.
The ID is not an athlete, resource or credential identifier. Raw exceptions,
stacks, request URLs/headers/bodies, tokens, provider bodies and health/workout
content are never passed to this logger. Logging failure cannot block recovery.
The persistent operational tables remain the source for the admin report if a
platform log expires. A killed request might only appear as stalled work.

Find these warnings in the matching deployment's
[Vercel Runtime Logs](https://vercel.com/docs/logs/runtime). Verify the account's
actual retention and operator access at launch; retention varies by plan.
Platform request/build logs and dependencies are separate from this application
projection: restrict access, inspect a controlled failure for sensitive output,
and do not enable request bodies, SQL parameters or provider debug logging.
Do not share raw request log links or screenshots with cookies or private paths.

## Operator response

1. Record environment, deployment SHA, time, operation and safe code only.
   Check the admin report after every release and reported sync failure.
2. For `STORAGE_UNAVAILABLE`/503, inspect deployment configuration and privately
   run the database probe. Check Neon availability and marker/grants before retry.
3. For `RATE_LIMITED`, honor the saved backoff. For rejected keys/account identity,
   ask the owner to reconnect their own provider; never collect their key.
4. For stalled sync, let the owner resume through the existing UI after lease
   expiry. For uncertain publication or `RECOVERY_REQUIRED`, use owner-authorized
   reconciliation before any further write. Preserve stable IDs and saved plans;
   Intervals success still leaves Garmin/watch unverified.
5. For widespread failures after release, stop further releases and follow
   [release rollback](release-operations.md) or [database recovery](database-recovery.md).

This MVP has no unattended job runner, Cron, automatic retry/publish or new
external error collector. An operator must review these signals; no automatic
paging is claimed. Optional platform alerts must contain only scrubbed fields
and need their own delivery/retention verification before being relied on.
