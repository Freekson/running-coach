import { zipFixture } from './fit-test-fixtures'
import { Encoder, Profile, type FileIdMesg, type LapMesg, type SessionMesg } from '@garmin/fitsdk'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { inspectFitDownload } from './fit-probe'

function syntheticFit(): Buffer {
  const encoder = new Encoder()
  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'development',
    product: 1,
    timeCreated: new Date('2026-01-01T00:00:00Z'),
  }
  const lap: LapMesg = {
    startTime: new Date('2026-01-01T00:00:00Z'),
    timestamp: new Date('2026-01-01T00:05:00Z'),
    totalElapsedTime: 300,
    totalDistance: 1000,
  }
  const session: SessionMesg = {
    startTime: new Date('2026-01-01T00:00:00Z'),
    timestamp: new Date('2026-01-01T00:05:00Z'),
    totalElapsedTime: 300,
    totalDistance: 1000,
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  encoder.onMesg(Profile.MesgNum.LAP, lap)
  encoder.onMesg(Profile.MesgNum.SESSION, session)
  return Buffer.from(encoder.close())
}

describe('FIT structure probe', () => {
  it.each([
    ['FIT', syntheticFit()],
    ['ZIP', zipFixture([{ name: 'activity.fit', bytes: syntheticFit() }])],
  ] as const)('extracts lap structure from %s without returning records', (format, bytes) => {
    const report = inspectFitDownload(bytes, 1)
    expect(report.format).toBe(format)
    expect(report.fitIntegrity).toBe(true)
    expect(report.decodeErrors).toBe(false)
    expect(report.hasSession).toBe(true)
    expect(report.hasLap).toBe(true)
    expect(report.lapCountMatchesSummary).toBe(true)
    expect(report.lapFields).toContain('totalDistance')
    expect(JSON.stringify(report)).not.toContain('1000')
  })

  it('rejects unsupported bytes without exposing their contents', () => {
    expect(() => inspectFitDownload(Buffer.from('private data'), null)).toThrow(
      'FIT download is not a supported ZIP or FIT file',
    )
  })
})
