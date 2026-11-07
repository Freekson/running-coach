import { deflateRawSync } from 'node:zlib'
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

function zipFit(fit: Buffer): Buffer {
  const name = Buffer.from('activity.fit')
  const compressed = deflateRawSync(fit)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(fit.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(fit.length, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return Buffer.concat([local, name, compressed, central, name, end])
}

describe('FIT structure probe', () => {
  it.each([
    ['FIT', syntheticFit()],
    ['ZIP', zipFit(syntheticFit())],
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
