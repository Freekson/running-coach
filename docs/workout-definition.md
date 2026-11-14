# Canonical WorkoutDefinition v1 (RUN-28)

The provider-neutral contract lives in `src/schemas/workout-definition.v1.ts`.
It is shared validation code with no server, database or provider dependencies;
editors and server services can import it directly. `WorkoutDefinition` and the
step, target and termination types are inferred from Zod. The recursive
`WorkoutNode` / `WorkoutRepeat` types describe the bounded runtime tree.

## Contract decisions

- `schemaVersion` is the numeric literal `1`. Unsupported versions fail validation;
  future migrations must be explicit. This is a format version, separate from a
  saved workout's immutable revision number.
- A definition has a required `name`, `sport` (`RUNNING`, `CYCLING`, `SWIMMING`,
  `WALKING`, `OTHER`) and ordered, nonempty `steps`.
- A `step` has an optional `name`, one `termination` and one `target`.
- A `repeat` has an integer `count` and ordered, nonempty child `steps`. It executes
  its entire child sequence exactly `count` times; the count includes the first
  execution. There are at most three repeat ancestors above a leaf step. Root
  steps have zero repeat ancestors.
- Termination is `time` with positive `durationSeconds`, `distance` with positive
  `distanceMeters`, or `lap` with no numeric value (continue until a manual lap
  press). Fractional seconds and meters are accepted and preserved.
- Targets are `free`, `pace` with `minSecondsPerKm` / `maxSecondsPerKm`, or
  `heartRate` with integer `minBpm` / `maxBpm`. Ranges are inclusive, with minimum
  at most maximum; equal endpoints express an exact target. Lower seconds per
  kilometer means faster pace. Units are fixed in field names, independent of
  the athlete's preferred display units. Heart-rate zones and relative pace
  targets require separate future contract decisions.
- Every object is strict. Unknown keys (including owner IDs, credentials, FIT,
  Garmin and Intervals.icu payload fields) fail instead of being silently removed.
  Parsing does not coerce units, inject defaults, trim text, flatten repeats or
  change ordering. Names have 1–160 characters.

`WORKOUT_LIMITS` sets at most 100 nodes per sibling list, repeat counts of 1–100,
time up to 604,800 seconds, distance up to 1,000,000 meters, pace up to 36,000
seconds/km, and heart rate up to 300 bpm. These are contract bounds, not training
or medical recommendations. Numbers must be finite. A finite schema tree rejects
excess depth before descending further, including very deep or cyclic objects.
File importers must also bound bytes before JSON parsing; this module accepts an
already parsed value and does not implement file upload handling.

## Validation and JSON Schema

Use `workoutDefinitionSchema.safeParse(unknownValue)` at untrusted boundaries.
Failures return a `ZodError` with typed `issues`, including `code`, `path` and
`message`; `parse` throws the same error type. Paths include step indexes and
target/termination fields for editors and future repair prompts. Do not log the
untrusted payload alongside errors.

`src/schemas/workout-definition.v1.json-schema.ts` exports
`workoutDefinitionJsonSchema`, generated directly with Zod's `toJSONSchema` as
Draft 2020-12. Serialize it with `JSON.stringify` when a downstream consumer needs
a JSON file. Finite repeat nesting, strict objects, enum values, units and scalar
bounds are present in the generated schema. Standard JSON Schema cannot compare
two sibling numeric values: range ordering is enforced by Zod and documented in
the schema's `$comment`. Consumers must run Zod semantic validation as well.

The synthetic `nestedIntervalsWorkout` fixture covers every termination/target
and nested repeat ordering. Tests verify JSON roundtrip equality, typed rejection
paths, depth boundaries and the generated schema's structural constraints.

This ticket adds no persistence, owner permissions or publication action.
Services that save definitions must authenticate and authorize owners separately.
A valid definition does not approve a plan or authorize publication. RUN-40 maps
approved definitions to provider formats; RUN-34 owns the surrounding AI file
exchange contracts. The referenced private Linear JSON Contract document was
unavailable during implementation; these field names and bounds are explicit v1
decisions based on the supplied ticket and local architecture/database docs.
