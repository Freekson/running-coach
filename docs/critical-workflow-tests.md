# Critical workflow verification (RUN-52)

[RUN-52](https://linear.app/fr-running-coach/issue/RUN-52/run-critical-end-to-end-and-failure-path-tests)
is a release gate. Passing local tests does not complete its deployed browser,
provider or Forerunner 165 checks. Keep the issue In Progress until those checks
pass or a provider/device limitation has been reproduced and recorded.

## Repeatable local checks

Use a migrated, isolated development/test database marked `NON_PRODUCTION`,
`DATABASE_URL`, `DIRECT_URL`, `APP_DATABASE_ENV` and `BETTER_AUTH_SECRET` as described
in [database setup](local-docker-db.md). Never point these tests at Production.

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm build
```

`test:db` includes `src/server/plans/critical-workflow.integration.test.ts` and
runs files serially. Explicit invocation fails if required configuration is
missing. The normal unit command skips database and opt-in live-provider suites.
Existing database identity checks run before synthetic fixtures are created.
CI's existing `privacy-regression` job runs this same database command against
disposable PostgreSQL; a local pass does not establish a hosted CI result.

The connected regression uses actual Better Auth signup cookies, ADMIN invitation
creation, verified owner contexts, goals, independent draft constraints, JSON
export/preview/approval, the persisted approved reader, encrypted provider vault,
publication outbox, sync checkpoints and activity matching on PostgreSQL. It
tests both athletes with separate Garmin identities and Intervals credentials.
Malformed JSON, superseded export selection, foreign owners, missing credentials,
lost publication responses, explicit recovery, repeated activity import and
missing HR/laps are checked along the same workflow. Approval and matching must
preserve the saved revision, and approval must create no publication intent.

Intervals HTTP uses the repository's stateful `publicationProviderFixture`,
which models calendar writes keyed by credential and stable external ID. No
Postman workspace mock was searched or imported; the established local fixture
is reused. Unexpected external fetches fail. Garmin's page adapter is injected
with synthetic normalized data: sync leases/checkpoints and canonical activity
persistence remain real, but Garmin HTTP parsing and live access are not proved
by this connected test. It is a server integration test, not a browser E2E test.
Only this suite's generated auth users, athletes and invitations are cleaned up.

## Failure-path coverage to run with it

| Requirement                                                                                                    | Existing executable evidence                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invite-only access, expired/forged sessions, ADMIN and two-user privacy                                        | `authorization/privacy.integration.test.ts`, `auth/auth.integration.test.ts`, auth/admin route tests                                                                                         |
| Initial/historical import, checkpoints, 429/backoff, provider failures, explicit resume                        | `garmin/data-import.integration.test.ts`, `garmin/sync.integration.test.ts`, `garmin/health-sync.integration.test.ts`, `garmin/import-rate-limit.integration.test.ts`                        |
| Leaving a page, no further client requests, manual retry controls                                              | `app/(auth)/app/settings/garmin-data-import.browser.test.tsx`, `app/(auth)/app/dashboard/garmin-sync-panel.browser.test.tsx`, `app/(auth)/app/training/activity-sync-panel.browser.test.tsx` |
| Malformed/invalid JSON, stale draft/request/revision, repair and explicit approval                             | `plans/exchange/import.integration.test.ts`, `plans/exchange/validation.test.ts`, plan wizard browser tests                                                                                  |
| Lost response, timeouts, duplicate/uncertain writes, revoked/disconnected key, retry, update/reschedule/cancel | `intervals/publication.integration.test.ts`, `plans/exchange/import.integration.test.ts`, `intervals/publication-client.test.ts`                                                             |
| Duplicate candidates, manual correction, missing metrics, completed history                                    | `activity/matching.integration.test.ts`, `activity/matching-metrics.test.ts`                                                                                                                 |
| Inbound source and scheduling configuration                                                                    | Garmin route tests, `app/api/internal/garmin-sync/route.test.ts`, checked-in `vercel.json` has no Cron                                                                                       |
| Deployment guards and errors                                                                                   | `lib/deployment.test.ts`, internal verification route tests, `scripts/vercel/*.test.mjs`; deployment itself needs separate evidence                                                          |

Paths are under `src/server/` unless prefixed with `app/` or `lib/` (under
`src/`), or `scripts/`. These tests cover the implemented boundaries; they do
not establish real provider guarantees or deployed environment configuration.

## Manual deployed and device procedure

Use two consenting test athletes with separate Garmin and Intervals accounts.
Keep credentials, invite URLs, cookies, raw health exports and account IDs out
of evidence. Record a safe actor alias instead. Repeat the user workflow below
for each athlete; verify isolation with both USER and ADMIN sessions.

1. Record commit SHA, environment (Preview or Production), deployment URL, migration
   and runtime-grant verification, timestamp and tester. Confirm canonical auth
   origin and environment-specific secret setup using [release operations](release-operations.md).
   Local, Preview and Production results are separate rows. Confirm no app Cron
   is configured and `GARMIN_SCHEDULE_ENABLED` is unset/false; a legacy internal
   trigger exists behind this opt-in flag and is not part of the manual MVP.
2. ADMIN creates two invites. Sign up in separate browser profiles; both start as
   USER. Anonymous and USER invitation creation must fail. Each athlete connects
   their own providers. Try foreign Goal/draft/plan/activity IDs: no disclosure,
   mutation or provider call is allowed, including for ADMIN.
3. Start Garmin initial/historical import explicitly. Observe checkpoints, leave
   the page and reopen it: no new client continuation starts while absent. An
   in-flight bounded request may finish. Select Resume/Retry explicitly. Exercise
   429, timeout and rejected credentials in a controlled test environment; wait
   for displayed backoff, replace rejected credentials and resume without duplicate
   activities. Repeat manual Health import and Sync now. Do not introduce a Cron
   or use Intervals as an inbound activity/health source.
4. Create a Goal and a draft with independent constraints. Export the JSON package
   and complete prompt, manually submit to ChatGPT, and import the response. Try
   malformed JSON, invalid steps and a superseded request; validate, obtain a
   repair response and preview again. Review warnings and explicitly approve.
   Check the saved revision and confirm neither import nor approval published.
5. Choose a supported nested running workout within the forwarding window from
   [workout mapping](intervals-workout-mapping.md). Follow [delivery setup](intervals-workout-delivery.md),
   including the athlete's own Garmin Connect link and **Upload planned workouts**.
   Review the changes and explicitly confirm Publish. Check the intended account,
   local date, target units and expanded repeat/recovery order. API success must
   leave Garmin Connect/watch **UNVERIFIED**. Sync Garmin Connect with the actual
   Forerunner 165; inspect its calendar and every workout step/target on the watch.
   Record watch model/firmware and sanitized photos or observations. Calendar or
   FIT API presence alone is not proof of watch receipt.
6. Execute the workout. Back in the app, manually select Garmin **Sync now**.
   Inspect the imported Activity, date/timezone, provenance, laps and actual
   metrics; confirm the intended match and view planned vs actual. Repeat Sync now
   to confirm deduplication. For duplicate candidates, inspect and select explicitly;
   missing data must remain unknown. Verify the approved revision is unchanged.
7. Exercise a controlled lost-write response and retry: reconcile before another
   create, retain one remote event and preserve the approved local plan. Check a
   rejected credential, failed read and timeout with the same preservation rule.
   Explicitly approve a future update/reschedule/cancel and separately publish it;
   completed history stays unchanged. Retry only through the visible recovery
   action. Recheck actual device state separately after remote changes.

For a failure, record expected versus observed behavior, safe error code,
checkpoint/publication state and recovery outcome. Distinguish **Not run**,
**Failed**, **Passed** and **Verified limitation**. Lack of access to an account,
deployment or watch is **Not run**, not a verified provider limitation. Record a
limitation only with reproduction evidence and an explicit accepted fallback.

## Release evidence ledger

Fill this table as checks are performed. Do not infer remote success from local
fixtures or mark RUN-52 Done from automated results alone.

| Environment / actor | Commit / deployment       | Check                                      | Result              | Evidence / limitation / recovery                             |
| ------------------- | ------------------------- | ------------------------------------------ | ------------------- | ------------------------------------------------------------ |
| Local synthetic A/B | Working tree on `a8459dc` | Connected server workflow                  | Passed (2026-11-25) | PostgreSQL + local Intervals HTTP; Garmin adapter injected   |
| Preview A/B         | Not recorded              | Browser loop, provider failures, privacy   | Not run             | Requires deployed sessions and controlled provider scenarios |
| Live Intervals A/B  | Not recorded              | Explicit publish/update/cancel/recovery    | Not run             | Requires each athlete's account                              |
| Forerunner 165 A/B  | Not recorded              | Date/targets/steps and completed session   | Not run             | Actual device inspection required                            |
| Preview A/B         | Not recorded              | Manual Garmin import and planned vs actual | Not run             | Requires completed device Activities                         |
| Production A/B      | Not recorded              | Environment smoke and complete loop        | Not run             | Separate deployment and runtime-grant evidence required      |

Local validation on 2026-11-25: `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test` (1,723 passed; 270 database/live tests skipped),
`pnpm test:db` (264 passed), and `pnpm build` passed. The final checkpoint
assertions also passed with `pnpm test:db --testNamePattern=RUN-52` (one connected
test, 263 unrelated tests skipped). No shared UI changed; Storybook was not run.
Hosted CI, Preview, Production and real provider/device checks were not run.

The first database run exposed the missing existing RUN-51 migration locally.
After `pnpm db:assert:development` verified `NON_PRODUCTION`, `pnpm db:migrate`
applied `20261125100000_run51_account_deletion` to `running_coach_local` on
`127.0.0.1:55432`; no new migration was authored. The first unit run timed out
in `prisma.config.test.ts` under concurrent checks; the full rerun passed.
The nested workflow initially exposed the single-step FIT fixture mismatch;
the test now explicitly checks `EXPORT_UNVERIFIED` and supplies a matching
six-step FIT before recovery. A fixture TypeScript error found by the first
build was corrected; the subsequent build and typecheck passed. The build also
emitted a Next.js security upgrade reminder for the installed version; resolving
that dependency warning is outside this test-only change.
