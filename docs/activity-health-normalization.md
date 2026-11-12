# RUN-23: Activity and health normalization

`src/server/activity/normalization.ts` and `src/server/health/normalization.ts` define the validated provider-neutral shapes. They carry the verified owner ID, provider, source record type, and external activity ID/UUID where available. The Garmin transform is in `src/server/garmin/normalization.ts`. Intervals.icu and manual/file adapters can produce the same canonical activity shape, but their source mappings are not yet verified or implemented.

Adapters require an `OwnerContext` issued from a verified session by `getOwnerContext`; a forged object with a user ID fails at runtime. No client supplied user ID is accepted by the Garmin transform.

## Units and missing values

RUN-77 adds optional nullable `calories` (nonnegative integer) and `activityTitle` (trimmed, at most 200 characters) to the canonical activity contract, reusing existing database columns. Existing producers can omit these fields. Garmin maps `summaryDTO.calories` and `activityName`; list summaries carry the metric fields directly. Missing values never erase saved calories or titles. Cycling, walking and swimming now map to their canonical sport categories; unknown types retain the original source sport and use `OTHER`.

| Canonical field                    | Unit or meaning                  | Garmin source                                                         |
| ---------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `distanceMeters`, elevation fields | meters                           | `summaryDTO.distance`, `elevationGain`, `elevationLoss`               |
| `totalMs`, `elapsedMs`, `movingMs` | milliseconds, distinct durations | `summaryDTO.duration`, `elapsedDuration`, `movingDuration` in seconds |
| `avgSpeedMps`                      | meters per second                | `summaryDTO.averageSpeed`                                             |
| heart-rate fields                  | beats per minute                 | `averageHR`, `maxHR`; daily `heartRate.restingValue`                  |
| `cadenceStepsPerMinute`            | running steps per minute         | `averageRunningCadenceInStepsPerMinute` only                          |
| `sleepDurationMs`                  | milliseconds                     | `sleepTimeSeconds` in seconds                                         |

Second-based provider durations are rounded to the nearest integer millisecond after checking finite and safe bounds; ordinary floating-point representation of fractional seconds is not treated as invalid data.

Pace is derived as `durationMs / distanceMeters` seconds per kilometer. Missing or zero duration/distance yields `null`. Missing HR, HRV, GPS, sleep, cadence, laps and Body Battery are `null`, never zero. `gpsAssetRef` is a nullable reference to a future private GPS asset; the Garmin JSON summary cannot populate it. No GPS coordinates are exposed in this contract. HRV and Body Battery remain unmapped because their Personal API units or descriptor positions are unverified. The Garmin adapter ignores unknown response fields rather than persisting raw private payloads.

Garmin's offset-less `startTimeGMT` is explicitly treated as UTC; `startTimeLocal` is only checked against an IANA zone when both are present, at the precision supplied by the local timestamp. Numeric sleep GMT timestamps must be plausible Unix milliseconds. A numeric local timestamp is checked against the GMT instant and supplied IANA zone, including DST; it is never used as the instant. When only a local sleep timestamp is available, `sleepStartedAt` remains `null` while a valid measured duration is retained. Inconsistent paired values fail validation.

FIT Lap messages are decoded through the existing bounded FIT/ZIP decoder. Callers pass an optional file through the provider-neutral `ActivitySource.normalizeActivity` options. Before attaching laps, the adapter requires an Activity FIT file with Session messages whose earliest start is within two minutes of the JSON start and whose summed distance is within the greater of 100 m or 2% of the JSON distance. If JSON or any FIT Session distance is absent, the activity remains valid with `laps: null` because attachment cannot be verified. If JSON elapsed duration is available, the span from first Session start to last Session end must be within the greater of one minute or 5%. Each Lap must fall within a Session's time span, have a timestamp-consistent duration when one is reported, avoid overlap with other laps, and not make the known lap distances exceed the corresponding Session distance. Missing or conflicting FIT identity fails closed. Invalid Lap data raises a distinct error so an importer can keep the verified JSON activity without attaching those laps. A future fetch/import service must also verify that the downloaded FIT belongs to the authenticated owner's requested provider record. Laps are tagged `FIT_LAP`; FIT timer time is not assumed to equal moving time. A Lap is not asserted to match every visible Garmin split. This contract does not persist laps or any activity data.

`sportType` uses `RUNNING`, `CYCLING`, `SWIMMING`, `WALKING`, or `OTHER`; adapters must translate provider labels before producing the canonical shape. The Garmin adapter currently recognizes only `running`, preserving every original type in `sourceSportType` and assigning unverified types to `OTHER`. Duplicate candidate matching excludes `OTHER` until an adapter maps its sport confidently.

## Identity and duplicates

Same-provider upsert uses `(userId, provider, externalActivityId)`. The UUID is provenance, not an alternate upsert key. Records without an external ID, such as manual entries, require a local identity assigned by the future import/storage service and do not get an automatic provider upsert key. The database's existing unique constraint uses the same owner/provider/external-ID tuple.

Cross-provider activity comparison is owner-scoped and only produces a **review candidate** when sport matches, start times are within two minutes, distance is within the greater of 100 m or 2%, and elapsed duration is within the greater of one minute or 5%. Missing distance or elapsed duration gives no candidate. Candidate status never merges, deletes, or links rows automatically. RUN-24 can add explicit source links after a human or stronger verified identity decision; analytics should select a configured authoritative source and avoid summing candidate duplicates.

Daily health observations remain source-specific by owner, provider, source record type, local date and timezone. Garmin daily summary and sleep responses normalize independently, so sleep can be present without a daily summary. Their source record IDs remain `null` until a provider ID is verified; no ID is fabricated from the date. Selecting an authoritative source and combining observations into a daily database row are separate RUN-25 concerns. No database migration or production sync behavior is introduced here.
