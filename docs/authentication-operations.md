# RUN-17: Better Auth operations

## Configure each environment

Better Auth runs inside the app. There is no Clerk account, custom domain,
email sender, Resend or SMTP configuration.

| Variable             | Local development                                      | Vercel Preview                                                                           | Vercel Production                                    |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Random secret, at least 32 bytes, in gitignored `.env` | Separate random Vercel Preview secret                                                    | Separate random Vercel Production secret             |
| `BETTER_AUTH_URL`    | `http://localhost:3000`                                | Stable Preview branch alias, e.g. `https://<project>-git-development-<scope>.vercel.app` | Stable Production `https://<project>.vercel.app` URL |
| `DATABASE_URL`       | Pooled development runtime role                        | Pooled development runtime role                                                          | Pooled production runtime role                       |
| `APP_DATABASE_ENV`   | `development`                                          | `preview`                                                                                | `production`                                         |

Set variables for **only** their matching Vercel environment. Never select
“All Environments” for secrets or `DATABASE_URL`. `BETTER_AUTH_SECRET` is
server-only; never prefix it with `NEXT_PUBLIC_` or place it in GitHub Actions.
Generate a fresh value separately for each environment with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
in a private terminal, then save it directly in the matching secure setting.
The `BETTER_AUTH_URL` must be a real stable origin for that environment. Vercel
sets `VERCEL_URL` and `VERCEL_BRANCH_URL` for the current deployment; the app
includes those exact origins for signup CSRF checks, so immutable Preview URLs
work too. No broad `*.vercel.app` trust wildcard is used.

`DIRECT_URL` is needed by the Prisma migration jobs and the trusted operator
CLI, **not** by the Vercel app runtime. Keep it in the restricted GitHub
migration environments as described in [release operations](release-operations.md).
For local CLI operations, keep the development direct role URL in gitignored
`.env`. Remove all old `CLERK_*` and `NEXT_PUBLIC_CLERK_*` variables from local
and Vercel settings.

## Apply migration

The additive `20261031_better_auth_foundation` migration creates auth and
invitation tables. `20261031_z_auth_rate_limit` adds the shared Better Auth
rate-limit table. Neither deletes `users` or athlete data. RUN-16 branch
pipelines apply it through `prisma migrate deploy` **before** deploying the
corresponding Vercel version, then run the runtime grants. Do not run
`prisma db push`, production `migrate dev`, or a migration during build.
Better Auth's login limits use the shared `auth_rate_limits` table, so all
Vercel instances count the same attempts. Vercel supplies the client IP in
`x-forwarded-for`; no separate rate-limit service is needed.

For a local development database only, confirm its private
`database_identity.tier=NON_PRODUCTION`, then run `pnpm db:assert:development`,
`pnpm db:migrate`, `pnpm db:grant:runtime` and `pnpm db:status`.

## Create and share an invitation

Use a private operator terminal with the matching `DIRECT_URL`,
`APP_DATABASE_ENV=development` and `BETTER_AUTH_URL`. Run:

```powershell
pnpm auth:invite
```

The CLI checks the database tier and prints one registration URL. It stores
**only SHA-256 of the random 32-byte token** in `auth_invitations`; the raw link
is never stored server-side. The token sits in the URL fragment (`#token=...`),
which is not sent in the initial HTTP request; the page removes it from the
address bar after loading. Copy it privately to the intended person via
Telegram, Discord or another trusted channel. Do not place it in source,
issues, logs, screenshots or public chat. The holder can choose an email and
password once within seven days. The link does not prove email ownership;
`emailVerified` remains false. Invalid form fields and Better Auth 4xx responses
leave the link available for retry; an unknown server failure can still consume
the link conservatively, so issue a new one if sign-in also fails. Public
`POST /api/auth/sign-up/email` without a valid token returns 403.

For production, run from a controlled terminal with the production direct
role URL and `APP_DATABASE_ENV=production`, after independently checking the
Neon project, then `pnpm auth:invite --production`. The explicit flag and
`database_identity=PRODUCTION` check guard the command. Codex does not run it.

Until RUN-18 adds the ADMIN-only UI, revoke a link using the migration role in
the **selected** Neon database, identifying the invitation row by its `id`:

```sql
UPDATE auth_invitations
SET revoked_at = now()
WHERE id = '<verified-invitation-uuid>'
  AND consumed_at IS NULL
  AND revoked_at IS NULL;
```

The app never reveals the token again. RUN-18 may list metadata and generate
new links, but cannot reconstruct an old raw link from the hash.

## Bootstrap the first ADMIN

1. Generate a link through the trusted CLI and privately share it with the
   initial operator. Register normally. The new account starts `USER`.
2. Sign in once at `/app` so the local `users` row is created. Verify the
   Better Auth user ID in the **matching** database's `auth_users` table and
   confirm its `users.auth_subject` maps to the intended internal user. For
   example, with the direct role in the matching Neon SQL editor:

   ```sql
   SELECT a.id AS auth_user_id, a.email, u.id AS app_user_id, u.role
   FROM auth_users AS a
   JOIN users AS u ON u.auth_subject = a.id
   WHERE a.email = '<operator-email>';
   ```

3. With the matching direct migration role URL, run
   `pnpm auth:bootstrap-admin <verified-auth-user-id>` for development, or
   append `--production` for production. The CLI refuses if any ADMIN already
   exists, checks the database tier, and changes only that active local user.
4. Sign out and sign in again. `GET /api/me` should return the same internal
   `id` and `role: "ADMIN"`. No public promotion endpoint exists.

Do not use an email match alone to select the account. If legacy Clerk athlete
rows exist, verify identity out of band and update `users.auth_subject` through
a separately reviewed migration/operation before signup. The app refuses to
attach a new Better Auth ID to a legacy row by email; old sessions and Clerk
passwords are not migrated.

## Verify deployed behavior

In both Preview and Production, use separate test identities and no real
athlete data in Preview. Confirm unauthenticated `/api/me` returns 401 and
`/app` redirects to `/sign-in`. Try direct signup without a token, with an
expired/revoked link, then with a valid link; the first cases must return 403.
Confirm a used link cannot create a second account. Sign in/out and repeat
`/api/me`; expired or revoked sessions must return 401. The repo tests cover
these conditions, but deployed behavior remains a manual check until tested
against each live environment.
