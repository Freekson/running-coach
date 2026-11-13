// Synthetic FIT messages only; never provider files or athlete recordings.
import {
  Encoder,
  Profile,
  type FileIdMesg,
  type RecordMesg,
  type SessionMesg,
  type TimeInZoneMesg,
} from '@garmin/fitsdk'
export const recordsStart = '2026-11-08T08:00:00Z'
export function recordsFit(
  options: {
    records?: RecordMesg[]
    sport?: SessionMesg['sport']
    count?: number
    elapsedSeconds?: number
    gps?: boolean
    metrics?: boolean
    sessionZones?: number[]
    zoneMessages?: TimeInZoneMesg[]
  } = {},
) {
  const encoder = new Encoder()
  const start = Date.parse(recordsStart)
  const elapsed = options.elapsedSeconds ?? 1200
  const file: FileIdMesg = { type: 'activity', manufacturer: 'development', product: 1 }
  encoder.onMesg(Profile.MesgNum.FILE_ID, file)
  const session: SessionMesg = {
    sport: options.sport ?? 'running',
    startTime: new Date(start),
    timestamp: new Date(start + elapsed * 1000),
    totalElapsedTime: elapsed,
    totalTimerTime: elapsed - 20,
    totalDistance: 4000,
    avgPower: 230,
    maxPower: 350,
    totalTrainingEffect: 3.3,
    totalAnaerobicTrainingEffect: 0.5,
    avgTemperature: 17,
    timeInHrZone: options.sessionZones ?? [0, 100, 700, 300, 80, 0],
  }
  encoder.onMesg(Profile.MesgNum.SESSION, session)
  for (const message of options.zoneMessages ?? [])
    encoder.onMesg(Profile.MesgNum.TIME_IN_ZONE, message)
  const count = options.count ?? 121
  const records: RecordMesg[] =
    options.records ??
    Array.from({ length: count }, (_, index) => ({
      timestamp: new Date(start + (index / (count - 1)) * elapsed * 1000),
      distance: (index / (count - 1)) * 4000,
      ...(options.metrics === false
        ? {}
        : {
            heartRate: 140 + (index % 20),
            enhancedSpeed: 3.5,
            enhancedAltitude: 40,
            cadence: 80,
            power: 230,
          }),
      ...(options.gps === false
        ? {}
        : {
            positionLat: Math.round((40 * 2147483648) / 180) + index * 100,
            positionLong: Math.round((10 * 2147483648) / 180) + index * 100,
          }),
    }))
  for (const record of records) encoder.onMesg(Profile.MesgNum.RECORD, record)
  return Buffer.from(encoder.close())
}
