import 'server-only'

import { inflateRawSync } from 'node:zlib'
import { Decoder, Stream } from '@garmin/fitsdk'

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_FIT_BYTES = 8 * 1024 * 1024

export type FitProbeReport = {
  format: 'FIT' | 'ZIP'
  fitIntegrity: boolean
  decodeErrors: boolean
  hasSession: boolean
  hasLap: boolean
  hasSegmentLap: boolean
  lapCountMatchesSummary: boolean | null
  lapFields: string[]
}

function extractFit(bytes: Buffer): { format: 'FIT' | 'ZIP'; fit: Buffer } {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('FIT download exceeds probe limit')
  if (bytes.toString('ascii', 8, 12) === '.FIT') return { format: 'FIT', fit: bytes }

  // Read the ZIP central directory, since local headers may use data descriptors.
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('FIT download is not a supported ZIP or FIT file')
  const entries = bytes.readUInt16LE(eocd + 10)
  const directoryOffset = bytes.readUInt32LE(eocd + 16)
  if (entries === 0xffff || directoryOffset === 0xffffffff || directoryOffset >= eocd)
    throw new Error('Unsupported FIT ZIP directory')

  let offset = directoryOffset
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid FIT ZIP directory')
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const plainSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > eocd) throw new Error('Invalid FIT ZIP entry')
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset = next
    if (!/\.fit$/i.test(name)) continue
    if (flags & 1 || (method !== 0 && method !== 8)) throw new Error('Unsupported FIT ZIP entry')
    if (compressedSize > MAX_ARCHIVE_BYTES || plainSize > MAX_FIT_BYTES)
      throw new Error('FIT ZIP entry exceeds probe limit')
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error('Invalid FIT ZIP local header')
    const dataOffset =
      localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28)
    if (dataOffset + compressedSize > directoryOffset) throw new Error('Invalid FIT ZIP data range')
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize)
    const fit =
      method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_FIT_BYTES })
    if (fit.length !== plainSize) throw new Error('FIT ZIP size mismatch')
    return { format: 'ZIP', fit }
  }
  throw new Error('FIT ZIP contains no FIT entry')
}

/** Shared, bounded decoder for the structural probe and activity normalization. */
export function decodeFitDownload(bytes: Buffer) {
  const { format, fit } = extractFit(bytes)
  const decoder = new Decoder(Stream.fromBuffer(fit))
  if (!decoder.checkIntegrity()) throw new Error('Invalid FIT integrity')
  const { messages, errors } = decoder.read({
    includeUnknownData: false,
    decodeMemoGlobs: false,
  })
  if (errors.length > 0) throw new Error('Invalid FIT messages')
  return { format, messages }
}

/** Decodes in memory; returns structural evidence only, never FIT messages or values. */
export function inspectFitDownload(bytes: Buffer, summaryLapCount: number | null): FitProbeReport {
  const { format, fit } = extractFit(bytes)
  const decoder = new Decoder(Stream.fromBuffer(fit))
  const fitIntegrity = decoder.checkIntegrity()
  if (!fitIntegrity) {
    return {
      format,
      fitIntegrity: false,
      decodeErrors: false,
      hasSession: false,
      hasLap: false,
      hasSegmentLap: false,
      lapCountMatchesSummary: null,
      lapFields: [],
    }
  }
  const { messages, errors } = decoder.read({
    includeUnknownData: false,
    decodeMemoGlobs: false,
  })
  const laps = messages.lapMesgs ?? []
  const lapFields = [...new Set(laps.flatMap((lap) => Object.keys(lap)))].filter((field) =>
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field),
  )
  return {
    format,
    fitIntegrity: true,
    decodeErrors: errors.length > 0,
    hasSession: Boolean(messages.sessionMesgs?.length),
    hasLap: laps.length > 0,
    hasSegmentLap: Boolean(messages.segmentLapMesgs?.length),
    lapCountMatchesSummary: summaryLapCount === null ? null : laps.length === summaryLapCount,
    lapFields: lapFields.slice(0, 80),
  }
}
