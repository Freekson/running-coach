# Dashboard overview (RUN-43)

`/app/dashboard` uses the existing authenticated AppShell. The page captures one server instant for its greeting, local date, activity cutoff and freshness labels. Timezone priority is the valid athlete profile timezone, the existing saved activity-browser timezone cookie, then UTC. Measurement units follow the saved athlete setting.

## Persisted reads

The activity history service owns two additional compact selectors: `getDashboardActivityOverview` and `getDashboardRecentActivities`. Both reuse `activityReadScope` and the existing canonical activity serializer; linked Garmin-account visibility is preserved after disconnect. Both explicitly exclude unresolved duplicate candidates in either direction for the current owner, following the conservative exclusion option in the existing activity-import policy. No candidate is merged or deleted, and no new source preference is invented.

The summary reads only running records from eight calendar weeks through the captured instant. Weeks run Monday–Sunday in the selected timezone, using the existing DST-safe activity day boundary. Distance and duration sum available values; duration prefers timer, moving, then elapsed time. Missing values are unavailable, with a note when totals contain only part of the activities. Zero session counts are actual persisted-record counts. Average HR uses positive available HR values weighted by their activity duration, excluding records without a positive duration. Cycling and other sports remain eligible for the three-item recent list but do not enter running totals.

The eight-week Distance / Time / Runs chart uses the same saved summary rows and the segmented-control styling used by Health charts. Buttons expose each week and value to keyboard and screen-reader users. Hover or focus previews a week; leaving the chart clears its highlight and restores the current-week readout. The default label is “Current week”. Metric switching makes no network requests and adds no chart dependency. Earlier empty weeks are not asserted as verified Garmin coverage. Initial-import and sync coverage are shown separately in the Garmin panel.

Each chart column places its fixed-height plot above the date label. Wrapped mobile labels cannot shift the plot's top or baseline, including weeks with no runs.

The health snapshot selects resting HR, sleep duration and Sleep Score independently, scoped to the owner and linked Garmin account. Each measurement keeps its own latest verified date; a newer duration without a score does not hide an older available score, and a score without duration is still eligible.

The health preview reuses `getHealthSnapshot` and the compact variant of `HealthSnapshot`. Resting HR, sleep duration and supported Sleep Score retain their observation date and inferred timezone in the read model; the score belongs to the selected verified sleep observation. The compact Dashboard card shows metric icons and values without observation-date, timezone or last-check text. Readings older than seven calendar days are marked older. Missing readings never become zero. Open Health links to `/app/health`.

There is currently no workout planning/scheduling model. Next workout therefore shows a grounded empty/coming-soon state without creating records or offering an unimplemented action. Recent activities link to existing `/app/training/<id>` details, and View all opens Training history.

## Failure and synchronization behavior

Summary, recent activities, health and sync status reads settle independently. A failure renders a safe section error without hiding successful sections. The protected route loading state shows skeletons for the header, weekly metrics, chart, next workout, recent activities, health and Garmin panel using the same responsive grid. Placeholders are hidden from assistive technology, with one loading announcement and reduced-motion support. Reads never contact Garmin. The existing [incremental synchronization action](garmin-sync.md#dashboard-incremental-sync-run-43) refreshes the page after all bounded stream requests, including partial writes, so all overview numbers are reread from persisted data.

No schema migration or new environment variable is required. Unit, component and routing tests cover calendar/year/DST boundaries, weighted HR, missing values, independent failures, units, detail links, no provider calls on open/chart changes and owner-scoped query composition. The existing gated PostgreSQL history suite includes real owner-isolation and duplicate-exclusion coverage; it requires an explicitly configured isolated development/test target via `pnpm test:db`.
