# RUN-15: Neon and Prisma operations

Prisma ORM and Client are pinned to 6.19.0. The Vercel Node runtime uses
`@prisma/adapter-neon` with `DATABASE_URL` (Neon's pooled `-pooler` host).
Prisma CLI migration commands use `DIRECT_URL` through both
`schema.prisma`'s `directUrl` and `prisma.config.ts`. There is no
database migration in `next build` or a request handler.
The CLI rejects a direct URL whose host, port, database, or effective PostgreSQL
schema does not match the runtime URL after removing Neon's `-pooler` suffix.
This foundation uses only the `public` schema; a different `schema` URL
parameter is rejected because the checked-in operator SQL targets `public`.

Before returning a Prisma client, server code reads the private
`database_identity` row. Preview requires `NON_PRODUCTION`; Production requires
`PRODUCTION`. A missing row, wrong tier, or connection failure denies database
access. The marker is independent of Vercel environment labels, so the two
deployments cannot both use one marked database successfully.

## Provision environments

Create **separate Neon projects** for production and development. The
`development` branch's Vercel Preview deployment uses the development project;
feature branches do not deploy to Vercel. Do not copy production health data to
development. Use synthetic data in development and test. In **each** project,
create a distinct, ordinary PostgreSQL role named `running_coach_runtime` for
the pooled runtime URL **using SQL**, plus a separate migration role for the
direct URL. Do not use Neon Console's Roles → Add role for the runtime role:
Neon grants roles created that way `neon_superuser` membership. In a trusted SQL
client or the intended branch's SQL Editor, create it with a private generated
password:

```sql
CREATE ROLE running_coach_runtime WITH LOGIN PASSWORD '<private-random-password>';
```

Keep the actual password out of the repository, tickets, screenshots and logs.
See [Neon's SQL role guidance](https://neon.com/docs/manage/roles#manage-roles-with-sql).
The runtime role must not own tables or inherit the migration role or a
superuser role. Obtain both URLs from Neon rather than editing hostnames by
hand. After migrations, the operator runs `pnpm db:grant:runtime`: its
checked-in SQL grants application-table access and only `SELECT` on
`database_identity`, then aborts if the runtime role can write that marker.
Update the grant script for new application tables and re-run it after future
migrations. Keep
migration credentials in the operator's local secret store or a dedicated
migration CI environment, not in Vercel runtime settings. Restrict who can read
or change production secrets.

Set Vercel project environment variables as follows:

| Vercel target                   | `DATABASE_URL`              | `APP_DATABASE_ENV` | `DB_VERIFY_TOKEN` | `DIRECT_URL`               |
| ------------------------------- | --------------------------- | ------------------ | ----------------- | -------------------------- |
| Production (`main`)             | Production pooled Neon URL  | `production`       | private token     | unset                      |
| Preview (`development` only)    | Development pooled Neon URL | `preview`          | private token     | unset                      |
| Development (local environment) | Development pooled Neon URL | `development`      | optional          | local migration shell only |

Set these on the **specific Vercel environment**, not on All Environments.
The runtime also rejects a mismatched Vercel label or an unpooled/non-Neon URL.
`DB_VERIFY_TOKEN` is a separate random token of at least 32 bytes per deployed
environment, never a database password and never a `NEXT_PUBLIC_*` variable.
Separate projects, credentials, and Vercel variable scopes remain necessary;
the marker does not replace them.

## Apply a fresh database

1. Copy `.env.example` to a gitignored `.env` for a new development or test
   database. Replace both URLs with values for **the same** Neon database.
2. Run `pnpm install --frozen-lockfile` and `pnpm db:migrate` from a trusted
   operator/CI environment. This applies checked-in SQL with Prisma Migrate's
   migration ledger. Use `pnpm db:status` to check for unapplied migrations.
   `db:status` exits with code 1 while a migration is pending, even when the
   direct connection succeeds.
3. In Neon Console, independently confirm the **development/test project ID**,
   branch, database, and its **direct endpoint hostname**. Then run
   `pnpm db:mark:nonproduction ep-example.us-east-1.aws.neon.tech`, replacing
   the example with that exact hostname from Console. The command requires
   `APP_DATABASE_ENV=development` or `test`, rejects a Vercel environment,
   and compares this separately supplied hostname with both configured URLs,
   including their database and schema. It does not overwrite any existing
   marker. Do not derive the confirmation argument from `DIRECT_URL`; if the
   Console project is not the intended nonproduction project, stop.
4. Create `running_coach_runtime` using the SQL command above, then run
   `pnpm db:grant:runtime` with the migration role's direct URL. Verify the
   role permissions with the read-only queries below.
5. Run the integration test with `APP_DATABASE_ENV=development` or `test` and
   that isolated database's pooled/direct URLs: `pnpm test:db`. It creates only
   synthetic users and activities and removes them afterward. Never run it
   with production credentials.
6. After migration, deploy the corresponding application version. `postinstall`
   generates Prisma Client for the pinned schema during install/build.

The identity migration adds an enum and one constrained metadata table; it does
not change athlete tables or existing rows. It deliberately leaves the marker
empty so a new deployment fails closed until the correct operator initializes
it. Production migration/initialization is a **manual operator action**: verify
the production Neon project and backup/restore point, apply `pnpm db:migrate`
using that project's direct URL, insert the marker in that project's SQL Editor,
then run `pnpm db:grant:runtime` with its migration role:

```sql
INSERT INTO "database_identity" ("id", "tier") VALUES (1, 'PRODUCTION');
```

The insert fails if a marker already exists; inspect the existing tier instead
of overwriting it. Do not use `prisma db push` or `migrate dev` on production.
Never use `db:mark:nonproduction` for production. In each project's SQL Editor,
check the resulting privileges without reading athlete rows:

```sql
SELECT
  has_table_privilege('running_coach_runtime', 'public.database_identity', 'SELECT') AS marker_read,
  has_table_privilege('running_coach_runtime', 'public.database_identity', 'INSERT') AS marker_insert,
  has_table_privilege('running_coach_runtime', 'public.database_identity', 'UPDATE') AS marker_update,
  has_table_privilege('running_coach_runtime', 'public.database_identity', 'DELETE') AS marker_delete,
  has_table_privilege('running_coach_runtime', 'public.activities', 'SELECT') AS activity_read,
  has_table_privilege('running_coach_runtime', 'public.activities', 'INSERT') AS activity_insert;
```

The expected result is `true` for read/insert columns on application tables,
`true` for `marker_read`, and `false` for all marker-write columns. If the
marker-write result is `true`, replace the runtime role with one that has no
owner or inherited migration privileges; a `REVOKE` alone cannot remove those.
There is no automatic down migration. Recover a failed rollout by stopping
writes, restoring to a verified Neon point-in-time/branch, and redeploying the
matching app version. Confirm backup/PITR availability for the chosen Neon plan
before launch.

The migration includes composite `(user_id, connection_id)` foreign keys so a
sync row or credential cannot attach to another athlete's connection. Service
code must still derive `userId` from verified auth and scope every read/write;
the schema does not grant admin access to athlete records or enable RLS.

## Verify deployed environments manually

The private `HEAD /api/internal/db-verify` route performs one read-only marker
query. It requires the `x-db-verify-token` header. With a missing/wrong token it
returns `404`; with a valid token it returns `204` for a matching database or
`503` for a missing/mismatched/unreachable marker. Every response has an empty
body and `Cache-Control: private, no-store`. It never returns URLs, credentials,
database names, rows, or driver errors. There is no public mutation endpoint.

1. In the **Neon Console**, confirm that Production and development are
   different projects. Select each intended project and branch before copying
   its pooled connection URL. Do not create development from a production branch
   containing athlete data. In the production project's SQL Editor, select the
   intended branch/database. Apply the migration from a trusted shell using the
   direct URL, then run the production marker insert above in the SQL Editor.
   Verify only the tier with
   `SELECT tier FROM "database_identity" WHERE id = 1;`. Confirm the runtime
   and migration URLs use different database roles and run the privilege
   queries above; the runtime role must have no write privilege on the marker.
2. In the **Vercel project → Settings → Environment Variables**, set each value
   in the table above with its own **Production** or **Preview** scope. Remove
   any `DATABASE_URL`, `APP_DATABASE_ENV`, or `DB_VERIFY_TOKEN` entry scoped to
   both environments or to All Environments. Confirm Preview uses the development
   project and Production uses the production project; compare Neon project IDs
   privately, without pasting URLs or passwords into tickets or logs. Keep
   `DIRECT_URL` out of both deployed environments. Ensure Vercel system
   environment variables are available so the app receives `VERCEL_ENV`.
3. In **Vercel → Deployments**, redeploy `development` (Preview) and `main`
   (Production) after changing variables. Check each deployment's environment
   and URL. Vercel variable changes do not affect existing deployments.
4. From a private HTTP client, send `HEAD` to each deployment's
   `/api/internal/db-verify` with its matching `x-db-verify-token`. Both must
   return `204` with an empty body. A missing/wrong token must return `404`.
   `503` means the marker, configuration, or database connection needs review.
   Do not place tokens in shared screenshots, shell command history, or logs.
   For example, in PowerShell, enter the token interactively, then use:

   ```powershell
   $verifyToken = Read-Host 'DB verification token'
   curl.exe -I -H "x-db-verify-token: $verifyToken" 'https://YOUR-DEPLOYMENT/api/internal/db-verify'
   Remove-Variable verifyToken
   ```

   Repeat with the other deployment URL and its own token.

5. Because one database has only one tier, a shared Preview/Production database
   cannot produce `204` for both deployments. Keep the Neon project-ID check in
   step 1 as an independent confirmation.

[Vercel environment variables](https://vercel.com/docs/environment-variables)
are scoped per deployment environment and require redeployment after changes.
[Vercel system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)
include `VERCEL_ENV`.

## RUN-15 evidence and remaining gates

| Acceptance criterion                                   | Status                         | Verified here                                                                                                                | Manual / remaining verification                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh environment applies repository migrations        | Partially verified             | Both checked-in migrations applied to development Neon; `db:status` reports current                                          | Applying the full history to a separate empty database is unverified; production migration requires backup review and operator action                                    |
| Server read/write and transactions work in Vercel Node | Partially verified             | Local Neon integration test verifies synthetic reads, writes, rollback, and cross-user FK rejection                          | Deployed Vercel marker read is unverified; deployed transactions remain unverified until a private authenticated service path exists                                     |
| Preview cannot mutate production athlete data          | Blocked on manual verification | A production-labeled runtime pointed at development Neon is rejected by the live marker test; a missing marker denies access | Verify distinct Neon project IDs, scoped Vercel variables, production marker, and both deployed HEAD results; no production connection or athlete data was accessed here |

**Blocked here:** direct inspection of Vercel settings/deployments and production
Neon is unavailable without account access. Do not mark this criterion verified
from local tests alone.
