# Authorization and privacy regression tests

[RUN-50](https://linear.app/fr-running-coach/issue/RUN-50/implement-cross-user-authorization-and-privacy-regression-tests)
adds `src/server/authorization/privacy.integration.test.ts` to the existing domain
regressions and the `test:db` command. It uses invite-only signup and real Better
Auth cookies for two USER athletes and an ADMIN. Authentication, owner contexts,
domain services and PostgreSQL remain real. Only Next request headers/cache hooks
are supplied by the harness. Unexpected provider fetches fail the tests.

## Run locally

Use an isolated, migrated development/test database with `DATABASE_URL`,
`DIRECT_URL`, `APP_DATABASE_ENV=development` or `test`, and `BETTER_AUTH_SECRET`.
The database must carry the `NON_PRODUCTION` identity marker. The commands reject
Vercel environments and fail when explicitly requested without the required
configuration. Existing database environment checks verify the marker before
fixture creation. Follow [local database setup](local-docker-db.md) or
[database operations](database-operations.md) for provisioning.

```powershell
pnpm test:privacy:db
pnpm test:db
```

`pnpm test:privacy:db` runs the focused real-session suite. `pnpm test:db` also
runs the existing domain integration suites, including composite foreign-key,
Garmin import/checkpoint, credential, plan exchange and publication regressions.
`pnpm test` skips database/live-provider tests; a green unit run alone does not
establish database authorization coverage.

Fixtures contain synthetic athlete data and generated test credentials. Cleanup
deletes only the auth users, athlete records and invitations created by this
suite. No real provider is contacted. Session expiry tests restore only their
synthetic sessions, including sessions Better Auth deletes when expired.

## Coverage

| Boundary                      | Focused real-session regression                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitations/admin             | Anonymous and USER denied on list/create/status/regenerate/revoke and user listing; invitation rows/count unchanged; ADMIN creation succeeds; the same session loses admin access immediately after DB demotion.                                                          |
| Role escalation               | Client `role`, `userId`, `id` and `authSubject` cannot grant ADMIN during signup/update or reassign athlete identity; profile role injection rejected.                                                                                                                    |
| Goals and drafts              | Owner lists; guessed detail/update/archive/delete; foreign Goal as a draft parent; constraints update; victim state preserved.                                                                                                                                            |
| Plans/revisions/workouts      | Foreign plan/history/revision reads; owned plan with foreign revision/workout IDs; calendar changes and activity matching; explicit owner approval still succeeds.                                                                                                        |
| JSON exchange                 | Owner export and consent selection; foreign export download/request IDs; mixed owned/foreign draft and request IDs; import preview and explicit approval denial; no private repair payload; valid owner import as a positive control.                                     |
| Health and activity           | Each actor sees their own health history/trends and weight history, including forged target query parameters; guessed activity detail and nested laps denied; admin user directory omits health and credential fields.                                                    |
| Credentials/imports/providers | Only actor credentials are decrypted/status-projected; guessed connection IDs denied; forged credential/import/sync targets rejected; target query parameters cannot disconnect the victim; foreign publication confirmation and outbox retry denied before provider I/O. |
| Notifications                 | In-app plan reminders list only the owner; another plan's valid fingerprint cannot dismiss it or open its refresh draft.                                                                                                                                                  |
| Invalid authentication        | Anonymous/forged/expired sessions and SUSPENDED/DELETING accounts cannot access protected reads or mutations; forged owner objects rejected.                                                                                                                              |

Cross-user mutation cases run for both USER and ADMIN attackers. Before/after
snapshots cover the victim's goals, drafts, plans, revisions, revision memberships,
workouts, exchange requests, outbox/attempts, reminder state, activities/laps,
health/weight, provider connections/credentials and sync runs. Successful local
approval is also checked to leave provider publication unchanged.

Export fixtures use yesterday's eligible activities, FIT laps and recovery
observations, with distinct metrics per athlete. Assertions require populated
owner evidence and verify that withholding consent removes it. Approval attacks
acknowledge all owner-preview warnings, establish readiness for explicit approval,
and require an ownership validation error. Reminder attacks and their successful
owner dismissal control use the same clock; synthetic session expiry and reminder
state are restored afterward.

## CI and limits

The `privacy-regression` job provisions disposable PostgreSQL 18, applies the
checked-in migrations, marks that disposable database `NON_PRODUCTION`, then runs
`pnpm test:db`. Development and Production migration jobs require this job and
the existing quality checks to pass. Its credentials are synthetic CI-only
values and require no deployment secrets.

These are server entry-point/service integration tests, not a deployed browser
or penetration test. Existing service and route unit tests complement the matrix;
it is not a claim about every possible future endpoint. Web Push is deferred and
has no implemented subscription endpoint to test; notification coverage is the
MVP in-app reminder flow. Account-wide export/deletion belongs to RUN-51; RUN-50
covers the implemented plan JSON exchange. Live Garmin/Intervals requests, actual
watch delivery, Neon runtime grants/RLS and GitHub-hosted CI execution require
separate environment evidence. There are no schema changes in RUN-50.
