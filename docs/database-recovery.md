# Database backup and recovery (RUN-53)

Use with [database operations](database-operations.md),
[release operations](release-operations.md), and the
[account deletion restore policy](account-data-lifecycle.md#backups-and-restore-after-deletion).
Application rollback does not roll back schema, data or external provider effects.

## Before launch and before a risky migration

- Record the production Neon project/branch alias, PostgreSQL major version,
  actual history/PITR window, earliest restorable time, backup operator and an
  agreed RPO (maximum acceptable lost writes) and RTO (maximum outage).
  Check the chosen plan's recovery capability; do not infer it from local tests.
  Neon documents [history windows](https://neon.com/docs/postgres/backup-restore/history-window)
  and [branch creation and restore](https://neon.com/docs/manage/branches).
- Verify a pre-migration recovery point is inside that window. Check compatibility
  with the still-serving app; use expand/migrate/contract for breaking changes.
  Review pending SQL, locks, runtime grants and RUN-70 preparation. Never reset,
  run `db push`, edit applied SQL, or automatically mark a failed migration resolved.
- Inventory every branch, dump and independently retained copy; enforce the
  existing **at most 30 days** backup policy. A retained branch is a data copy,
  not an exception to retention. Store historical encryption keys privately for
  only the lifetime of backups needing them; record a purge owner and date.
- Keep the latest deletion receipts in protected storage outside the database
  being restored, daily and after confirmed deletion, preserving original expiry.
  No app background task implements this operator obligation. Missing current
  receipts block reopening until deletion requests are reconciled.
- If using an independent logical backup, use matching PostgreSQL tools and a
  direct operator connection supplied through protected libpq environment/service
  settings, never a URL/password in command arguments or logs. Encrypt the dump
  before leaving protected operator storage; verify access and expiry. A dump
  does not contain database roles or the encryption key ring.

## Repeatable synthetic recovery drill

From an installed checkout with Docker running:

```powershell
pnpm db:test:recovery
```

The command creates a new PostgreSQL 18 container, publishes a random loopback
port, applies every checked-in Prisma migration to an empty `source` database,
and seeds synthetic storage fixtures. Readiness requires an authenticated TCP
query; the image's temporary initialization socket cannot satisfy it.
It ignores existing database URLs and
never loads `.env` in the driver; its Prisma subprocess overrides both URLs.
It takes a custom-format `pg_dump` inside the container, restores to a separate
empty `restored` database, checks the migration ledger and reapplies migrations
idempotently. Assertions verify the database marker, survivor/removed owner,
immutable revision snapshot and current pointer, measurement, sync checkpoint,
uncertain publication, encrypted credential with its historical synthetic key,
and idempotent replay of a deletion receipt newer than the backup.

The container and its anonymous volumes are removed on success/failure. If
cleanup fails or the process is forcibly killed, remove only the printed
`run53-recovery-<uuid>` container after confirming its identity. No persistent
Docker volume or application database is reused. Failures report only a fixed
phase. The co-located tests check error scrubbing and cleanup boundaries.

CI's `recovery-smoke` runs this command without secrets on clean checkout.
Both trusted migration jobs require it, `validate`, and `privacy-regression`.
This proves a local logical restore, not Neon PITR, Vercel configuration,
domain-valid plan JSON, runtime-role reconstruction, or real provider delivery.
Those need the independent checks below and `pnpm test:db`.

## Neon restore rehearsal and incident recovery

1. Record incident time, last good app SHA and selected recovery timestamp in UTC.
   Stop writes and releases before changing routing: protect all reachable app
   deployments (including old URLs), stop trusted workflow runs, and prevent
   users from initiating sync/publication. Do not rely on an app rollback to
   stop in-flight requests; allow bounded requests/leases to finish or expire.
2. Privately preserve the current deletion receipts, migration status and key
   inventory outside the damaged target. Keep the original branch for diagnosis
   within its retention policy. Do not overwrite the only current copy.
3. In the confirmed Neon project, create a **private recovery branch at the chosen
   timestamp** using the Console history/branch controls. For rehearsal use only
   synthetic data in an isolated nonproduction project. A production recovery
   copy remains production-sensitive; never attach it to public Preview, relabel
   its marker `NON_PRODUCTION`, or run fixture suites against it.
4. Use an offline matching checkout and the recovery branch's direct migration
   connection. Verify the project, endpoint, database and existing identity marker
   independently. Run `pnpm db:status`. If a migration was interrupted, inspect
   its actual SQL effects before choosing a forward repair or earlier point;
   do not automatically resolve it. Apply reviewed compatible pending migrations
   (`db:prepare:run70`, `db:migrate`) only after establishing the restored baseline.
5. Recreate/verify the restricted `running_coach_runtime` role as needed and run
   `pnpm db:grant:runtime`. Check marker SELECT-only and immutable plan grants
   with the queries in the database runbook. Dumps do not restore cluster roles;
   never use the migration role as the application connection.
6. Merge the latest protected deletion receipts and run
   `prisma/scripts/replay-account-deletions.sql` using the direct role **before
   reopening**; repeat to prove idempotence. Check synthetic deleted and surviving
   owners. Follow the account lifecycle policy for receipts unavailable during
   the incident. Invalidate restored sessions (`DELETE FROM auth_sessions` in
   the offline recovery database) and rotate authentication secrets as appropriate.
7. Privately verify retained ciphertext with the historical key ring. Revoke or
   quarantine restored provider access until owners reconnect/confirm current
   credentials. Apply current secret rotations; a restored old key is not proof
   of current provider authorization. Never print plaintext to prove decryption.
8. Reconcile remote Intervals events against stable external IDs, including writes
   after the restore point and uncertain attempts. Do not reset the outbox to
   queued or automatically replay it. Keep saved approved plans immutable; let
   each owner approve recovery and resume Garmin imports manually. Check Garmin
   Connect/watch state separately from the API.
9. Point only the controlled Production deployment at the verified restored
   runtime target and matching key ring. Follow the trusted release path and
   run the smoke/checklist below. Confirm ownership with synthetic accounts and
   review admin failure signals. Reopen writes only after deletion, credentials
   and remote effects are reconciled. Record measured lost-write interval and
   outage against the agreed RPO/RTO; otherwise keep the release gate open.
10. Record sanitized result, source/recovery aliases, app SHA, restore time,
    grants/key/deletion/reconciliation results, elapsed time and purge deadlines.
    Purge temporary copies and retire old keys after their retention windows.

Do a synthetic Neon timestamp restore before first Production release and repeat
after recovery tooling or database changes. Local Docker success cannot close
that gate. No production restore, secret rotation or routing switch is performed
by the drill.
