# RUN-16 — Release and secret operations

This runbook covers the two deployed environments of the private Running Coach
app. [Database operations](database-operations.md) covers Neon roles, database
identity, and the private read-only connection check. RUN-60 owns the existing
`validate` lint, formatting, typecheck, test, and build job.

## Release path and safety boundary

The [Quality checks workflow](../.github/workflows/ci.yml) runs on a push to
either protected branch. Jobs in each branch run in this order:

| Branch        | Pipeline after merge                                      | Database target       | Vercel target |
| ------------- | --------------------------------------------------------- | --------------------- | ------------- |
| `development` | `validate` → `migrate-development` → `deploy-development` | Development Neon only | Preview       |
| `main`        | `validate` → `migrate-production` → `deploy-production`   | Production Neon only  | Production    |

`needs` prevents deployment when CI or migration fails. Workflow concurrency
serializes runs for each branch, so an older commit cannot deploy after a newer
run. GitHub may replace a waiting run with a newer one; the latest checkout
contains all checked-in migrations. Native Vercel Git auto-deployments are
disabled by [`vercel.json`](../vercel.json), preventing them from racing ahead
of migrations. The workflow deploys the exact commit that passed its jobs
through the pinned Vercel CLI. A merge is the release authorization; there is
no second approval step.

The migration jobs read `database_identity` with a direct connection before
applying anything. A development job requires `NON_PRODUCTION`; a production
job requires `PRODUCTION`. Missing or mismatched markers fail closed. Both jobs
then run `prisma migrate deploy`, refresh the restricted runtime role's grants,
and check migration status. The marker guard complements the RUN-15 runtime
guard and separate Neon projects; it does not replace environment scoping.

## Secret and environment inventory

| Value                                | Secure location                                                                                                                                       | Purpose                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                       | Vercel Production Secret: production pooled runtime role. Vercel Preview Secret: development pooled runtime role. Local `.env`: development only.     | Application reads, writes, transactions. Never use All Environments.                                                       |
| `APP_DATABASE_ENV`                   | Vercel Production: `production`; Preview: `preview`. Local development: `development`.                                                                | Runtime checks the Vercel label and private database marker.                                                               |
| `DB_VERIFY_TOKEN`                    | Distinct Vercel Production and Preview Secrets, at least 32 random bytes each.                                                                        | Authenticates read-only `HEAD /api/internal/db-verify`.                                                                    |
| `DATABASE_URL`, `DIRECT_URL`         | GitHub Environment **`development-migrations`** secrets; both point to development Neon, with pooled runtime and direct migration roles respectively. | Used only by the development migration job.                                                                                |
| `DIRECT_URL`                         | GitHub Environment **`production-migrations`** secret; production Neon direct migration role only.                                                    | Used only by the production migration job. The production pooled runtime URL is not copied to GitHub.                      |
| `VERCEL_TOKEN`                       | GitHub Environment **`development-deploy`** and **`production-deploy`** secrets. Use separate limited tokens if available.                            | Permits CLI deployments. No database URL is passed to deploy jobs; Vercel applies its own scoped runtime secrets remotely. |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | Variables in each deploy GitHub Environment.                                                                                                          | Bind the CLI to the existing Vercel project. Verify IDs privately before enabling the pipeline.                            |
| Credential encryption master key     | Future RUN-21 Vercel Production Secret and a separately generated Preview Secret, with versioned key management.                                      | No key is wired into current code. This acceptance item remains unverified until RUN-21. Never add it to GitHub or source. |

The production migration role is the **one approved exception** to the earlier
operator-only secret plan: automation needs its direct URL in the protected
`production-migrations` GitHub Environment. It has no application runtime role
or encryption key. Never put production URLs in repository-level Actions
secrets, source control, `.env.example`, `NEXT_PUBLIC_*`, logs, or issue comments.
Provider credentials added by later issues need inventory entries before use.

## One-time GitHub and Vercel setup

1. Confirm Neon production and development are separate projects, not branches
   copied from real athlete data. Verify their `database_identity` rows are
   `PRODUCTION` and `NON_PRODUCTION`, and verify the restricted runtime grants
   in [database operations](database-operations.md). The identity row must
   exist before the automatic migration job runs; bootstrap a fresh database
   manually with that guide.
2. In **GitHub → Settings → Environments**, create the four environments named
   above. For each `*-migrations` environment, set **Deployment branches and
   tags → Selected branches** to exactly `development` or `main`, respectively.
   Apply the same branch restriction to each matching `*-deploy` environment.
   Do not add required reviewers or a wait timer: the protected merge is the
   approval. Add only the secrets and variables shown in the inventory.
3. In **GitHub → Settings → Rules → Rulesets** (or **Branches**), protect both
   `development` and `main`. Require a pull request and the `validate` status
   from **Quality checks** before merge; block force pushes and branch deletion;
   apply rules to administrators where the plan permits. Require an up-to-date
   branch if available. Do **not** require migration or deploy jobs as PR
   checks: they intentionally run after merge. Restrict who can edit workflows
   and environment secrets. Confirm a PR run has no migration or deploy jobs
   executing and cannot read environment secrets.
4. In **Vercel → Project → Settings → Environment Variables**, keep Production
   and Preview values separate, with no shared `DATABASE_URL`,
   `APP_DATABASE_ENV`, or `DB_VERIFY_TOKEN`. Keep `DIRECT_URL` out of Vercel.
   Verify the linked Production Branch is `main`. Confirm
   `git.deploymentEnabled: false` is effective when this change lands; there
   must be no separate native Vercel deployment for the merge commit before
   the Actions migration completes. Vercel CLI deployments remain enabled.
5. After merging RUN-16 into `development`, inspect the first complete
   `validate → migrate-development → deploy-development` run and its Vercel
   target. Merge the RUN-16 release into `main` only after the protected
   production environment secrets and branch policy are ready. The RUN-16
   change itself has no schema migration.

GitHub private repositories need a plan supporting Environment secrets and
deployment branch policies (currently Pro, Team, or Enterprise). If these
controls are unavailable, **do not move the production direct URL to a
repository secret**; use an external OIDC-backed secret manager or change the
plan before enabling automatic production migration. GitHub rules are account
settings and cannot be verified from repository files. See [GitHub
environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
and [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches).

## Normal release and verification

1. Review additive SQL migrations and confirm the currently deployed app can
   run against the new schema. For a destructive change, first release code
   that stops using the old shape, then remove it in a later migration. Check
   Neon backup or point-in-time restore availability before the merge.
2. Merge the reviewed PR into `development`. Watch its workflow run. If any
   job fails, no new Preview deployment starts. Inspect the successful Vercel
   deployment's source SHA and Preview target, then check `/status` and the
   [private read-only database check](database-operations.md#verify-deployed-environments-manually).
3. After Preview is healthy, merge the release PR into `main`. The production
   migration job uses only the production direct role and marker. If it fails,
   no new Production deployment starts; the old version stays live. If it
   succeeds, inspect the Vercel deployment's source SHA, Production target,
   domain assignment, `/status`, private database check, and a normal
   authenticated application path.

The private endpoint proves read connectivity and the environment marker. It
does **not** prove deployed writes or transactions. That remains a RUN-15
integration gap until a private authenticated service path is available.
Never run `prisma db push` or `migrate dev` on production.

## Failed release and rollback

- If CI or a migration fails, leave the previous deployment serving traffic.
  Inspect `prisma migrate status`, repair with a reviewed forward migration,
  and merge the fix. Do not automatically run down migrations or mark a failed
  migration applied without investigating its actual database state.
- If the new code fails but the database is healthy, roll back to the previous
  compatible Production deployment in **Vercel → Deployments** and verify the
  domain and key paths. The schema remains migrated. Verify the old deployment's
  environment snapshot; changing a Vercel secret does not rewrite existing
  deployments. Keep older deployments protected or revoke stale credentials.
- If a migration damages data or blocks both app versions, stop writes and
  jobs, assess the recovery point and potential data loss, then restore via
  Neon operator tools. Recheck role grants and database identity before
  reopening traffic. This requires an incident decision outside CI.

See [Vercel production rollback](https://vercel.com/docs/deployments/rollback-production-deployment).

## Secret rotation

1. Create a new credential in its owning system. For a database runtime role,
   prefer a new restricted role with verified grants so existing deployments
   keep working during rotation. Rotate production and development separately.
2. Update the matching Vercel Environment Secret or migration GitHub
   Environment Secret. A Vercel change needs a new deployment to take effect;
   trigger it with a reviewed merge. A migration secret change is exercised by
   the next trusted branch run. Verify the deployment and database marker.
3. Revoke the old credential only after the new deployment or migration run
   succeeds. Inspect reachable older deployments and GitHub workflow logs for
   accidental exposure without printing secret values.
4. RUN-21 must implement key versions and re-encryption or dual-read handling
   before rotating the encryption master key. Replacing a single key value
   without migrating ciphertext can make credentials undecryptable.

See [Vercel secret rotation](https://vercel.com/docs/environment-variables/rotating-secrets).

## Acceptance status at this repository change

| Criterion                                                           | Status                                                           | Evidence or remaining check                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production credentials and encryption master key in secure settings | **Partially verified**                                           | Production pooled runtime URL is Vercel-scoped by the user's report. The approved migration-only `DIRECT_URL` belongs in a main-restricted GitHub Environment; its configuration needs manual verification. The encryption key is not implemented (RUN-21).                          |
| Preview cannot access real health or the production database        | **Partially verified**                                           | RUN-15 runtime marker guard and distinct labels are in code. User reports separate Neon databases and successful deployed read-only checks in both environments. Neon/Vercel settings and Preview data provenance still need manual review; no deployed write isolation test exists. |
| Production migration, deploy, and rollback                          | **Implemented in workflow and documented; execution unverified** | `main` jobs run CI, marker check, migration, then Vercel deployment. No production migration or deployment was run here. Configure protected environments before the first merge.                                                                                                    |
| CI required for merges where settings permit                        | **Workflow verified in repository; rule unverified**             | RUN-60 `validate` remains the only PR quality gate. A repository administrator must confirm required-status rules for both protected branches.                                                                                                                                       |
| Automatic development migration and Preview deployment              | **Implemented; execution unverified**                            | `development` jobs chain CI, marker check, migration, and Vercel deployment. Configure development-only Environment secrets and verify the first post-merge run.                                                                                                                     |
