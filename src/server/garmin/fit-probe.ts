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

function isFit(bytes: Buffer): boolean {
  return (
    bytes.length >= 14 && [12, 14].includes(bytes[0]) && bytes.toString('ascii', 8, 12) === '.FIT'
  )
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function extractFit(bytes: Buffer): { format: 'FIT' | 'ZIP'; fit: Buffer } {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('FIT download exceeds probe limit')
  if (isFit(bytes)) return { format: 'FIT', fit: bytes }
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50)
    throw new Error('FIT download is not a supported ZIP or FIT file')
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('Invalid FIT ZIP directory')
  const entries = bytes.readUInt16LE(eocd + 10)
  const directoryOffset = bytes.readUInt32LE(eocd + 16)
  if (
    entries < 1 ||
    entries > 32 ||
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== entries ||
    directoryOffset + bytes.readUInt32LE(eocd + 12) !== eocd
  )
    throw new Error('Unsupported FIT ZIP directory')
  let offset = directoryOffset
  let totalPlain = 0
  let fit: Buffer | null = null
  const ranges: { start: number; end: number }[] = []
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid FIT ZIP directory')
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const crc = bytes.readUInt32LE(offset + 16)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const plainSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > eocd) throw new Error('Invalid FIT ZIP entry')
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    totalPlain += plainSize
    const unixMode = bytes.readUInt32LE(offset + 38) >>> 16
    if (
      !name ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.startsWith('/') ||
      name.includes(':') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      (unixMode & 0xf000) === 0xa000 ||
      bytes.readUInt16LE(offset + 34) !== 0 ||
      (flags & ~0x080e) !== 0 ||
      (method !== 0 && method !== 8)
    )
      throw new Error('Unsupported FIT ZIP entry')
    if (
      compressedSize > MAX_ARCHIVE_BYTES ||
      plainSize > MAX_FIT_BYTES ||
      totalPlain > MAX_FIT_BYTES
    )
      throw new Error('FIT ZIP entry exceeds probe limit')
    if (
      localOffset + 30 > directoryOffset ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50 ||
      bytes.readUInt16LE(localOffset + 6) !== flags ||
      bytes.readUInt16LE(localOffset + 8) !== method
    )
      throw new Error('Invalid FIT ZIP local header')
    const localNameSize = bytes.readUInt16LE(localOffset + 26)
    const dataOffset = localOffset + 30 + localNameSize + bytes.readUInt16LE(localOffset + 28)
    if (
      dataOffset + compressedSize > directoryOffset ||
      !bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(nameBytes) ||
      (!(flags & 8) &&
        (bytes.readUInt32LE(localOffset + 14) !== crc ||
          bytes.readUInt32LE(localOffset + 18) !== compressedSize ||
          bytes.readUInt32LE(localOffset + 22) !== plainSize)) ||
      ranges.some((range) => localOffset < range.end && dataOffset + compressedSize > range.start)
    )
      throw new Error('Invalid FIT ZIP data range')
    ranges.push({ start: localOffset, end: dataOffset + compressedSize })
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize)
    const plain =
      method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, plainSize) })
    if (plain.length !== plainSize || crc32(plain) !== crc)
      throw new Error('FIT ZIP integrity mismatch')
    if (isFit(plain)) {
      if (fit !== null) throw new Error('Ambiguous FIT ZIP entries')
      fit = plain
    }
    offset = next
  }
  if (offset !== eocd || !fit) throw new Error('FIT ZIP contains no FIT entry')
  return { format: 'ZIP', fit }
}

function boundedRead(decoder: Decoder, deadlineAt: number) {
  let count = 0
  const checkLimit = () => {
    if (++count > 100_000 || Date.now() > deadlineAt) throw new Error('FIT decode limit exceeded')
  }
  return decoder.read({
    mesgListener: checkLimit,
    mesgDefinitionListener: checkLimit,
    mergeHeartRates: false,
    includeUnknownData: false,
    decodeMemoGlobs: false,
  })
}

/** Shared, bounded decoder for the structural probe and activity normalization. */
export function decodeFitDownload(bytes: Buffer, deadlineAt = Date.now() + 5_000) {
  const { format, fit } = extractFit(bytes)
  const decoder = new Decoder(Stream.fromBuffer(fit))
  if (!decoder.checkIntegrity() || fit.length !== fit[0] + fit.readUInt32LE(4) + 2)
    throw new Error('Invalid FIT integrity')
  const { messages, errors } = boundedRead(decoder, deadlineAt)
  if (errors.length > 0) throw new Error('Invalid FIT messages')
  return { format, messages }
}

/** Decodes in memory; returns structural evidence only, never FIT messages or values. */
export function inspectFitDownload(bytes: Buffer, summaryLapCount: number | null): FitProbeReport {
  const { format, fit } = extractFit(bytes)
  const decoder = new Decoder(Stream.fromBuffer(fit))
  const fitIntegrity = decoder.checkIntegrity() && fit.length === fit[0] + fit.readUInt32LE(4) + 2
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
  const { messages, errors } = boundedRead(decoder, Date.now() + 5_000)
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
