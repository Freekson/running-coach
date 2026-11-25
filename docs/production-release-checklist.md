# Production release checklist (RUN-53)

Track **implemented**, **deployed Preview**, and **verified Production** separately.
Use [RUN-53](https://linear.app/fr-running-coach/issue/RUN-53/prepare-observability-backuprestore-and-production-release-checklist)
for release evidence. A merged PR or Done dependency does not prove the deployed
or device checks. In particular, RUN-52's repository ledger still lists live
checks as Not run; replace those entries only with observed evidence.

## Clean checkout and release preparation

- [ ] Start a clean checkout of the exact reviewed commit. Use Node 22 and
      pnpm 10.30.3; run `pnpm install --frozen-lockfile`. Install must only generate
      Prisma Client, never migrate. Supply no production secrets to PR checks.
- [ ] Follow [fresh database setup](database-operations.md#apply-a-fresh-database)
      for a new isolated synthetic target: matching pooled/runtime and direct/migrator
      URLs, full migrations, explicit identity marker and runtime role/grants. First
      Production bootstrap is the documented operator action; later merges use CI.
- [ ] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
      `pnpm test:db`, `pnpm build` and `pnpm db:test:recovery`. For shared UI changes
      also run `pnpm build-storybook`. DB suites require NON_PRODUCTION and synthetic
      fixtures. Record skipped suites and actual results, not just exit codes.
- [ ] Review pending migration SQL for old/new app compatibility, locks and data
      loss. Record a valid recovery point and a successful synthetic Neon rehearsal
      using [database recovery](database-recovery.md), including RPO/RTO and deletion
      receipt/key availability. A local logical restore alone does not satisfy PITR.
- [ ] Triage and resolve dependency security advisories before Production release.
      The local RUN-53 build reported a Next.js security upgrade recommendation for
      installed 16.4.3. A successful retry does not establish that the advisory is
      resolved; no dependency upgrade is included here.
- [ ] Confirm the [secret inventory and scoped provider settings](release-operations.md#secret-and-environment-inventory),
      distinct Neon projects/markers, restricted runtime roles, Preview synthetic
      data only, separate auth/vault/verification secrets, no `DIRECT_URL` in Vercel,
      no secrets in `NEXT_PUBLIC_*`, and canonical auth origins for each environment.
- [ ] Verify GitHub environment/branch protections and required `validate`,
      `privacy-regression`, `recovery-smoke` jobs where the plan supports them.
      Confirm Vercel Git auto-deployments are disabled and `vercel.json` has no Cron.
      The user handles Git operations; a protected merge authorizes the normal
      CI → migration/grants → exact-commit deployment, with no second approval.

## Deployment smoke

After each Preview/Production deployment, confirm the environment, commit SHA,
successful migration/grant/status job and Vercel deployment/alias mapping. A
failed gate must prevent the new deployment. Follow [rollback](release-operations.md)
on failure; do not run automatic database down migrations.

Run the non-destructive smoke command from a private shell, supplying the
matching deployment verification token through process environment rather than
a command argument. For example in PowerShell 7:

```powershell
$env:RELEASE_SMOKE_DB_TOKEN = Read-Host 'Deployment DB verification token' -MaskInput
pnpm release:smoke https://YOUR-DEPLOYMENT.vercel.app
Remove-Item Env:RELEASE_SMOKE_DB_TOKEN
```

The command requires a bare HTTPS origin (local loopback HTTP also works), never
follows redirects, uses a 15-second timeout per request, and reports check names
without response bodies or tokens. It verifies `/status` 200, anonymous `/api/me`
and `/api/admin/operations` 401, signup without an invite 403, hidden DB probe
404 and authenticated database marker probe 204. Private responses must have
`no-store`. The signup probe sends only `{}` and cannot create an account.
Vercel protection/login redirects fail the smoke; run through the authorized
deployment access mechanism, without weakening protection to pass. These checks
do not establish authenticated ownership, JSON exchange or watch receipt.

- [ ] Sign in as ADMIN, see operational health and use a controlled synthetic
      failure to verify the report and scrubbed Vercel warning. USER gets 403 from
      the API; expired/forged/demoted sessions cannot gain operational access.
      Confirm platform log access/retention and no raw credentials or health output.
- [ ] Test fresh signup without invite and expired/used/revoked links, then a
      valid ADMIN invitation. Invitee becomes USER and cannot manage invitations.
- [ ] With two distinct test users plus ADMIN, attempt foreign Goal, PlanDraft,
      plan/revision, Activity/Health, credentials and publish/match operations.
      Verify reads and writes are denied; ADMIN has no extra health access.
- [ ] Complete manual JSON request export → response import → validation/repair
      → preview → explicit immutable plan approval. Test malformed and stale JSON.
      Neither import nor approval may create an external publication.
- [ ] Separately approve Publish to each owner's Intervals account. Exercise
      lost-response/timeout/revoked-key retry and reconcile one remote event.
      Verify supported nested steps, date and targets on an actual Forerunner 165;
      record firmware and safe observations. API/FIT success leaves watch unverified.
- [ ] Execute the workout, manually Garmin **Sync now**, confirm deduplication,
      missing data behavior and planned-vs-actual matching. Exercise initial import,
      Resume/Retry, rate-limit/backoff and leaving the page. No unattended inbound
      sync, automatic publication or Intervals activity importer is enabled.

Use [RUN-52's full procedure](critical-workflow-tests.md) for these scenarios,
including verified provider/device limitations and accepted fallbacks. Lack of
access is **Not run**, not a verified limitation.

## Evidence record (one per environment and release)

Record operator alias, UTC timestamp, exact SHA/deployment, migration status,
safe test results, recovery point/window, observed RPO/RTO, and links to private
sanitized evidence. Keep secrets, invite URLs, account IDs and raw athlete data
out of the ledger. Block launch on Failed/Not run required gates.

| Gate                                                    | Local                                      | Preview                       | Production                     |
| ------------------------------------------------------- | ------------------------------------------ | ----------------------------- | ------------------------------ |
| Full checks / real-session privacy                      | Passed, 2026-11-25                         | Not run                       | Not run                        |
| Empty migration + logical backup/restore                | Passed: disposable PostgreSQL, 2026-11-25  | Not run                       | Not run                        |
| Neon timestamp recovery + grants/keys/deletion receipts | Not applicable                             | Not run (synthetic rehearsal) | Not run (configuration review) |
| Environment smoke + admin failure visibility            | Local HTTP smoke + real-session API passed | Not run                       | Not run                        |
| Invite-only + cross-user + JSON roundtrip               | Passed: synthetic integration suite        | Not run                       | Not run                        |
| Explicit publish + actual watch + manual Garmin match   | Not applicable                             | Not run                       | Not run                        |

No deployment, Neon PITR, real provider action or device check is certified by
this implementation. RUN-53 remains open until required live evidence is recorded.

## Local implementation evidence, 2026-11-25

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: passed.
- `pnpm test`: 1,738 passed; 271 opt-in DB/live tests skipped after the review fixes. The first run
  exposed the admin routing test's single-child assumption; it was updated and
  the complete rerun passed.
- `pnpm test:db`: all 265 tests passed on the configured local NON_PRODUCTION
  database, including the real-session RUN-53 aggregate API test (anonymous,
  other USER, active ADMIN, same-session demotion, hostile stored error and
  successful runs with partial-import warnings). Date/FIT regressions verify
  partial warning persistence/logging and clean retries.
- `pnpm build`: passed on retry after the Next.js security upgrade notice above.
  `pnpm build-storybook`: passed with Vite client-directive/sourcemap and chunk
  warnings. Healthy/failure/unavailable/mobile stories are included; no visual
  browser/device or 200% zoom inspection was performed.
- `node scripts/migrations/test-recovery.mjs` (the `db:test:recovery` entry point):
  initially passed in 12 seconds on disposable PostgreSQL 18.
  After review, `pnpm db:test:recovery` passed in 33 seconds with authenticated TCP
  readiness; no remaining drill containers. Its regression test simulates a
  socket-ready/TCP-unavailable startup and verifies migrations wait for TCP.
  Initial runs caught invalid synthetic goal/publication enum values; corrected
  fixtures passed the complete drill. No schema migration was added or applied
  to the application database by this task.
- `pnpm release:smoke http://127.0.0.1:31053`: all six checks passed against the
  built app with a synthetic process-local verification token. The database
  check read only the local identity marker. The temporary server was stopped.
- Hosted CI, Neon PITR and restore-role reconstruction, deployed settings/log
  inspection, Preview/Production smoke, live provider effects and Forerunner 165
  verification: **Not run**. RUN-16/RUN-52 being Done does not replace these checks.

Suggested PR title: `feat(ops): add private diagnostics and release recovery gates (RUN-53)`.
The change adds scrubbed operational reporting and an ADMIN aggregate panel/API,
gates trusted releases on a synthetic backup/restore drill, and supplies deployment
smoke checks and recovery/release runbooks. It changes no schema or provider
retry/publish behavior. Live acceptance and the dependency advisory remain open.
