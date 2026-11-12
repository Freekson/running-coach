// Synthetic binaries for tests only. No provider files or athlete data.
import { deflateRawSync } from 'node:zlib'
import {
  Encoder,
  Profile,
  type SessionMesg,
  type FileIdMesg,
  type LapMesg,
  type RecordMesg,
} from '@garmin/fitsdk'

export function syntheticActivityFit(
  options: {
    sport?: SessionMesg['sport']
    laps?: number
    metrics?: boolean
    distance?: boolean
    start?: string
    declaredLaps?: number
    reverse?: boolean
    emitLaps?: boolean
    summaryTimestamp?: 'end' | 'start' | 'before_start' | 'after_end'
    summaryFirst?: boolean
  } = {},
): Buffer {
  const encoder = new Encoder()
  const start = Date.parse(options.start ?? '2026-11-08T08:00:00Z')
  const count = options.laps ?? 4
  const summaryTimestamp = (end: number) =>
    new Date(
      options.summaryTimestamp === 'start'
        ? start
        : options.summaryTimestamp === 'before_start'
          ? start - 60_000
          : options.summaryTimestamp === 'after_end'
            ? start + count * 300_000 + 3_600_000
            : end,
    )

  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    timeCreated: new Date(start),
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  const session: SessionMesg = {
    sport: options.sport ?? 'running',
    startTime: new Date(start),
    timestamp: summaryTimestamp(start + count * 300_000),
    totalElapsedTime: count * 300,
    ...(options.distance === false ? {} : { totalDistance: count * 1000 }),
    numLaps: options.declaredLaps ?? count,
  }
  if (options.summaryFirst) encoder.onMesg(Profile.MesgNum.SESSION, session)
  const indices = Array.from({ length: count }, (_, index) => index)
  if (options.reverse) indices.reverse()
  for (const index of options.emitLaps === false ? [] : indices) {
    const lap: LapMesg = {
      sport: options.sport ?? 'running',
      startTime: new Date(start + index * 300_000),
      timestamp: summaryTimestamp(start + (index + 1) * 300_000),
      totalElapsedTime: 300,
      totalTimerTime: 290,
      ...(options.distance === false ? {} : { totalDistance: 1000 }),
      ...(options.metrics === false
        ? {}
        : {
            avgHeartRate: 145,
            maxHeartRate: 170,
            avgCadence: 80,
            avgFractionalCadence: 0.5,
            avgPower: 230,
            maxPower: 300,
            enhancedAvgSpeed: 3.333,
            enhancedMaxSpeed: 4.5,
            totalAscent: 12,
            totalDescent: 9,
          }),
    }
    encoder.onMesg(Profile.MesgNum.LAP, lap)
  }
  const record: RecordMesg = {
    timestamp: new Date(start),
    heartRate: 147,
    positionLat: 123456,
    positionLong: 654321,
  }
  encoder.onMesg(Profile.MesgNum.RECORD, record)
  if (!options.summaryFirst) encoder.onMesg(Profile.MesgNum.SESSION, session)
  return Buffer.from(encoder.close())
}

export function syntheticMultisportFit(
  options: {
    firstSessionLapCount?: 0 | 1 | null
    includeFirstLap?: boolean
    secondElapsedSeconds?: number
  } = {},
): Buffer {
  const encoder = new Encoder()
  const start = new Date('2026-11-08T08:00:00Z')
  const secondStart = new Date(start.getTime() + 600_000)
  const secondElapsed = options.secondElapsedSeconds ?? 600
  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    timeCreated: start,
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  const first: SessionMesg = {
    sport: 'training',
    startTime: start,
    timestamp: start,
    totalElapsedTime: 600,
    totalTimerTime: 0,
    totalDistance: 0,
    ...(options.firstSessionLapCount === null
      ? {}
      : { numLaps: options.firstSessionLapCount ?? 0 }),
  }
  const second: SessionMesg = {
    sport: 'cycling',
    startTime: secondStart,
    timestamp: start,
    totalElapsedTime: secondElapsed,
    totalTimerTime: Math.max(0, secondElapsed - 10),
    totalDistance: 1000,
    numLaps: 1,
  }
  encoder.onMesg(Profile.MesgNum.SESSION, first)
  encoder.onMesg(Profile.MesgNum.SESSION, second)
  if (options.includeFirstLap) {
    const lap: LapMesg = {
      startTime: start,
      timestamp: start,
      totalElapsedTime: 600,
      totalDistance: 0,
    }
    encoder.onMesg(Profile.MesgNum.LAP, lap)
  }
  const lap: LapMesg = {
    sport: 'cycling',
    startTime: secondStart,
    timestamp: start,
    totalElapsedTime: secondElapsed,
    totalTimerTime: Math.max(0, secondElapsed - 10),
    totalDistance: 1000,
  }
  encoder.onMesg(Profile.MesgNum.LAP, lap)
  return Buffer.from(encoder.close())
}

export function fixtureCrc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function zipFixture(entries: { name: string; bytes: Buffer }[], method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const compressed = method === 8 ? deflateRawSync(entry.bytes) : entry.bytes
    const crc = fixtureCrc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, compressed)
    directory.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(Buffer.concat(directory).length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...directory, end])
}
