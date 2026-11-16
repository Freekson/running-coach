# Plan creation wizard (RUN-37)

Open **Create training plan** from `/app/training`. The authenticated nested route
`/app/training/plan/new` uses the existing app shell and session owner.

## Athlete workflow

1. **Goal & Constraints:** select an existing, unarchived goal or create one with
   the shared goal form. Open the saved initial draft, review its timezone,
   training weekdays, session limits and future 14–28 day detail window, then
   save constraints and continue. Existing goals, profile defaults and PlanDraft
   records are reused. Opening this creation route never turns an existing
   approved plan into a refresh draft.
2. **Export / Chat / Import:** choose privacy opt-ins (all start off), inspect the
   exact request and stored training evidence, and copy the prompt or download
   the request JSON. Follow the instructions in ChatGPT and upload or paste the
   response JSON. Uploading only fills the response field. **Validate and preview**
   performs owner-scoped schema, semantic, freshness and workload validation.
   Blocking errors show their paths and recovery guidance; repairable errors
   provide a selectable, copyable repair prompt.
3. **Preview / Approve:** review the full-goal macro phases, every local calendar
   date in the detail window, canonical workout steps/targets, weekly estimates,
   imported notes and computed load warnings. Acknowledge every warning, then
   explicitly confirm the plan and click **Approve locally**. Approval saves an
   immutable local revision. The confirmation is cleared when review inputs change.

Manual ChatGPT exchange is the MVP generation stage and needs no OpenAI API key.
The generation stage composes the existing export feature independently from the
shared import/review/approval stages. Future automatic generation can replace this
stage and converge on the same response boundary. No automatic mode, credentials,
paid fallback, Garmin sync, provider request or publication is added here.
Publishing requires a separate explicit Intervals.icu action; this wizard does not
provide a shortcut that publishes imported suggestions. The shared wizard also
supports [approved-plan refresh](plan-refresh.md) through RUN-38's separate entry point.

## Persistence and authorization

Unsaved schedule edits, optional background/consent choices, the current export,
response text and current step are saved in browser localStorage under an
account-specific versioned key. Server constraints remain in the existing draft.
Local input is runtime-validated on restoration; malformed response text is
preserved for repair. Restoring a review never restores trusted validation,
warning acknowledgements or approval. The athlete must explicitly revalidate.
Storage failure is shown with instructions to keep the tab open or copy the
response. Browser storage is local to this browser, not a cross-device draft sync.
Successful approval removes that local wizard entry.

File reads immediately invalidate the prior review and keep validation, navigation
and import controls pending until reading completes. Preview results are discarded
if their input generation has changed. Approval uses the exact response text and
goal/draft/request identities that produced the displayed review; this binding is
never restored from browser storage. Reselecting the current goal is a no-op and
preserves the export, response and unsaved constraints.
Returning through step 1 without edits also preserves the current export and its
response identity. Editing the schedule, detail window or privacy choices still
invalidates the export; explicitly reopening or preparing another export requires
fresh validation.

All server actions authenticate independently and derive the owner from the
verified session. `approvePlanImport` reruns the issued-request validator and
warning review inside the same serializable transaction as draft validation and
immutable approval. The creation route accepts initial responses; the refresh
route uses the same service with explicit operations. Both require `approve: true`.
Live request/draft/goal versions, dates, identity collisions and warning IDs are
rechecked. Existing revision persistence handles immutable snapshots and conflict
retries. Concurrent approvals produce one revision; replay is refused. No
publication record is created. Invalid imports, stale exports and failed
approvals preserve the draft and every previously approved revision.

There are no schema migrations, new dependencies or environment variables. Existing
RUN-33/35/36 migrations and runtime grants must already be deployed.

## Verification

The implementation includes action authentication tests, browser interaction and
restoration tests, local storage validation tests, and guarded PostgreSQL approval
tests alongside `exchange/import.integration.test.ts`. Cases cover a first-time
athlete with no goal, invalid responses and repair prompts, warning/confirmation
gates, unsaved constraints and versions, account switching, file-size limits,
storage failure, same-draft reopening, cross-user/ADMIN access, wrong nested IDs,
superseded exports, changed constraints, replay, concurrent approval and preserved
approved history/publication counts.

On 2026-11-16, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test --maxWorkers=2`
(1,573 passed; 195 guarded DB/live tests skipped), `pnpm build` and
`pnpm build-storybook` passed. The full guarded `pnpm test:db --maxWorkers=2`
passed 188 tests; after adding the concurrent approval case, the targeted guarded
import/approval suite passed all 12 tests. No live provider or device delivery was
tested. Storybook has guided-flow, no-goals, failure and narrow-review examples.
The final focused UI/action/storage run passed 20 tests, including the added guard
that disables navigation and import while an export request is being issued.

The review follow-up adds four regressions for same-goal reselection, delayed file
reads with a changed 40-minute workout and no warnings, failed file reads, and
invalidated in-flight previews. All four failed against the reviewed code and
passed after the fixes; the focused UI/action/storage/export suite passed 24 tests.
The follow-up full suite passed 1,578 tests with 195 guarded DB/live tests skipped.
Formatting, lint, standalone typecheck, the production build and Storybook build
also passed. Database and provider behavior did not change in this client-only fix.

Headless Edge exercised the synthetic wizard through all three stages at 320px
and 375px, including 200% CSS zoom. It verified no horizontal page overflow,
the dark canvas, Manrope headings and visible 2px keyboard focus. The check found
and fixed an intrinsic grid-column overflow in the reused export preview. These
checks do not establish physical-device clipboard/download permissions or live
ChatGPT/provider interoperability.

Changed areas are the Training launch link and nested wizard route/actions,
the staged export feature and its persisted form schema/styles, transaction-aware
preview and revision approval services, the initial import approval service,
co-located stories/tests, and this workflow/validation documentation. No shared
primitive or generated contract artifact changed.
