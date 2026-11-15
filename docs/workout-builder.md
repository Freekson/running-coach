# Workout builder (RUN-29)

The authenticated `/app/workouts` page is available under Training → Workouts.
Build an ordered session from warmup, work, recovery, cooldown and repeat groups.
Those step names are editable labels; the v1 contract has no separate phase enum.
Each repeat performs its entire child list, including the last recovery. Move
and remove controls work without dragging. The same ordered editor and preview
trees are used at every viewport width.

End steps by time in seconds, distance in meters, or a manual lap press. Targets
are free, absolute pace in seconds/km, or absolute HR in integer bpm. For example,
240 seconds/km is 4:00 /km. HR zones, power and relative targets are unavailable
because the canonical v1 schema cannot represent them. Inline errors use that
same schema, including range ordering, numeric bounds, group sizes and three
repeat levels. Invalid edits disable use/download and hide the preview rather
than showing an estimate for stale valid values.

To construct 5 × 1000 m: add a warmup, add a repeat group (default count 5),
change its Work ending to Distance with 1000 meters, choose Pace and its bounds,
set Recovery to the desired time, then add a cooldown. Each child can be revised,
reordered or removed, and repeat groups can themselves contain repeats.

## Estimates

The preview sums explicit time/distance and derives the missing quantity only
from pace targets. Pace bounds yield a range; they do not assume a midpoint.
Free/HR steps with distance endings leave duration unknown; those with time
endings leave distance unknown. Lap steps leave both unknown. Partial totals
show their known contribution plus `unknown`. Repeat counts multiply the child
estimates without flattening the tree, avoiding huge expanded previews. Estimates
are guidance, not measured execution or watch delivery status.

## Reuse and persistence

`src/components/workouts/WorkoutBuilder.tsx` accepts an optional untrusted
`initialDefinition`, a `locked` state and an `onApply` callback. Initial values are
runtime-validated before editing; unsupported definitions are refused intact.
Use a React `key` containing the owner and revision when switching a mounted
builder to another session. Edits are local draft strings so empty and invalid
numbers remain editable. Callbacks receive only a validated canonical definition,
without editor IDs or inactive fields. Async apply disables edits and repeated
submissions; a failure retains the draft and displays a safe error.

The standalone page downloads valid canonical JSON and holds edits in memory.
Leaving or reloading discards edits; it does not claim to save a session or plan.
No template library, database migration, API mutation or external publisher is
introduced. Consumers editing a plan must pass `locked` for protected sessions,
authenticate/authorize on the server, and use RUN-33's immutable revision workflow
instead of mutating approved snapshots. The UI lock is not an authorization
boundary.

Storybook includes empty, 5 × 1000 m, nested, mobile, locked, unsupported-target,
pending and failed-apply states. DOM interaction tests cover construction,
revision, validation, structural keyboard controls, focus, locked/pending
submissions and canonical download. Unit tests cover roundtrip preservation,
contract rejections and estimate arithmetic.
