# In-app plan reminders (RUN-47)

Issue: [RUN-47](https://linear.app/fr-running-coach/issue/RUN-47/implement-actionable-persistent-in-app-plan-reminders).

Every authenticated page using `AppShell` evaluates reminders from persisted
current approved revisions and owner-scoped suppression records. The server
streams a subtle banner above page content without blocking the rest of the
shell. Evaluation makes no provider request, publication, background task or
scheduled evaluation. While refresh is available, each plan links directly to
the existing manual refresh flow at `/app/training/plan/refresh?planId=<planId>`; clicking it creates no
publication. Multiple eligible plans have separate banners.

The version 1 policy becomes due seven calendar days before the approved detail
window ends, or on the last day that a 14-day future refresh can fit inside the
macro period, whichever comes first. Dates use the timezone stored in that
revision's constraints. It remains due after the window ends. Workout density, completed sessions, Garmin sync,
publication status and later profile timezone edits do not change this policy.
There is no reminder for unapproved drafts, archived goals, a future window that
has not started, detail covering the macro end, or a completed macro period.
When the last valid refresh date passes, the same unresolved event remains
visible with a **Review plan** CTA and an explanation that a 14-day future refresh
no longer fits. It links to that approved plan's existing review page without
promising that a new plan can fit the unchanged goal. Dismissal and snooze still
apply to the same event across this transition. A changed goal target date that
requires a new plan stays quiet; the normal planning UI retains that guidance.
An evaluation error shows a small unavailable status and a link to review plans;
it never claims the plan is up to date.

The SHA-256 event fingerprint includes the policy version, plan ID and immutable
current revision ID. Repeated page loads, changing dates and renamed goals keep
the same event. Any new approved revision creates a new event if still due;
an extended window resolves the reminder until it becomes due again. This also
means an approved calendar move can resurface a reminder for review.

**Dismiss reminder** suppresses that event permanently. **Snooze 24 hours** stores
an absolute server timestamp and suppresses the event until exactly that instant.
Elapsed time is evaluated on the next normal page load/navigation, not by a
background timer. A stale snooze cannot undo an existing dismissal. Both actions
authenticate again, derive the owner from the verified session, validate a strict
command, re-read the active plan, reject obsolete fingerprints, and save in the
existing serializable transaction helper. Suppression never changes a draft,
approved revision or workout. ADMIN has no access to another athlete's records.

The feature composes the shared Card and Button components and semantic theme
tokens. Banners are labeled sections with semantic dates, visible text controls,
wrapping actions, coarse-pointer target sizes and no automatic focus on load.
Pending actions disable controls; failed saves keep the reminder visible and
announce an error. Successful saves announce through the root layout's shared
ToastProvider and focus its existing `main-content` landmark without scrolling.
Both survive server revalidation removing the saved reminder, even when the
action resolves after its originating banner has unmounted.
Feature stories cover due/exhausted, save failure, pending and 320px layouts.
The refresh, plan-review and unavailable-state links all use the existing
navigation guard, so unsaved Settings edits can be saved, discarded or retained
before navigation. Modified-click behavior remains Next.js Link's normal behavior.

## Deployment and recovery

Apply `20261117060000_plan_reminder_states` before deploying the app, then run
the existing `pnpm db:grant:runtime` release step. The additive migration creates
only `plan_reminder_states`, with a composite primary key on owner, plan and
fingerprint, and an owner-compatible foreign key to `training_plans`. Plan/account
deletion cascades suppression. No existing records are changed, no backfill is
needed and no new environment variables are required. Creation takes normal DDL
locks, including the brief referenced-table lock for the foreign key. Runtime
grants include the new mutable table; immutable revision grants stay intact.

Use the existing guarded development/production migration sequence in
`docs/database-operations.md` and CI. A code rollback can leave the additive table
and grants in place. Do not drop suppression records during rollback: doing so
would make previously dismissed events appear again.

Unit tests cover calendar boundaries, timezones, event stability and quiet states.
PostgreSQL integration tests cover persistent reload behavior, exact snooze expiry,
changed/resolved events, stale commands, forged owners, cross-user ADMIN denial,
composite foreign keys, account deletion and unchanged approved history. Action
tests cover authentication and sanitized errors; jsdom tests cover labels, dates,
pending/error states, retry and focus. Headless Chrome checks of the built stories
at 1280px and 320px confirm wrapping without horizontal overflow and keyboard
navigation through all three controls, including Enter-key dismissal. Physical
touch-device inspection, browser zoom and deployment-specific verification remain
manual checks; jsdom alone does not prove layout.

Regression tests also cover the last refresh opportunity, persistence into plan
review after that deadline, and the actual Settings form alongside reminder links
(cancel/keep editing, discard, save, and clean-form navigation). Focus and feedback
regressions cover removal of the banner both before and after a successful
dismiss/snooze response, using the real shared ToastProvider and a stable main
landmark.
The production-build flow was also checked with a synthetic signed-in athlete
and disposable PostgreSQL database: native Enter-key snooze and dismissal both
persisted suppression, removed the banner, retained the success notification and
left focus on `main-content` after real Server Action revalidation.
