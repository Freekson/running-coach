import 'dotenv/config'
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PrismaClient } from '@prisma/client'

function keyFor(version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid key version')
  const encoded = process.env[`CREDENTIAL_ENCRYPTION_KEY_V${version}`]
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('Missing encryption key')
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded)
    throw new Error('Invalid encryption key')
  return key
}

function aad(row) {
  return Buffer.from(`${row.userId}:${row.connectionId}:${row.connection.provider}:API_KEY`)
}

export function directDatabaseTarget(url) {
  return JSON.stringify([
    url.hostname,
    url.port === '5432' ? '' : url.port,
    url.pathname,
    url.searchParams.get('schema') || 'public',
  ])
}

export async function verifyDeployedKey(
  origin,
  token,
  keyVersion,
  activeVersion,
  databaseTarget,
  fetchImpl = fetch,
) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
    throw new Error('Invalid deployment origin')
  if (!token || Buffer.byteLength(token) < 32) throw new Error('Missing verification token')
  const challenge = randomBytes(32)
  const proof = createHmac('sha256', keyFor(keyVersion))
    .update('running-coach:credential-rotation:v2:')
    .update(challenge)
    .update(databaseTarget)
    .digest('base64url')
  const response = await fetchImpl(new URL('/api/internal/credential-key-verify', url), {
    method: 'HEAD',
    headers: {
      'x-db-verify-token': token,
      'x-credential-rotation-challenge': challenge.toString('base64url'),
      'x-credential-key-version': String(keyVersion),
    },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  const returnedProof = response.headers.get('x-credential-key-proof')
  const expected = Buffer.from(proof)
  const supplied = Buffer.from(returnedProof ?? '')
  if (
    response.status !== 204 ||
    response.headers.get('x-credential-key-version') !== String(keyVersion) ||
    response.headers.get('x-credential-active-version') !== String(activeVersion) ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new Error('Deployment key verification failed')
}

export async function verifyDeploymentKeys(
  origin,
  token,
  activeVersion,
  storedVersions,
  databaseTarget,
  fetchImpl = fetch,
) {
  const versions = new Set([activeVersion, ...storedVersions])
  for (const version of versions)
    await verifyDeployedKey(origin, token, version, activeVersion, databaseTarget, fetchImpl)
  return versions
}

function decryptRow(row) {
  if (row.connection.authMethod !== 'API_KEY' || row.connection.userId !== row.userId)
    throw new Error('Unsupported credential record')
  if (row.nonce.length !== 12 || row.authTag.length !== 16)
    throw new Error('Invalid credential record')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(row.encryptionKeyVersion), row.nonce)
  decipher.setAAD(aad(row))
  decipher.setAuthTag(Buffer.from(row.authTag))
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()])
}

export function verifyCredential(row) {
  const plaintext = decryptRow(row)
  plaintext.fill(0)
}

export function reencryptCredential(row, activeVersion) {
  const plaintext = decryptRow(row)
  try {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', keyFor(activeVersion), nonce)
    cipher.setAAD(aad(row))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
      ciphertext,
      nonce,
      authTag: cipher.getAuthTag(),
      encryptionKeyVersion: activeVersion,
      rotatedAt: new Date(),
    }
  } finally {
    plaintext.fill(0)
  }
}

export function rotationTierFor(environment) {
  if (environment === 'production') return 'PRODUCTION'
  if (['preview', 'development', 'test'].includes(environment)) return 'NON_PRODUCTION'
  throw new Error('APP_DATABASE_ENV must identify the target')
}

export function requiresDeploymentProof(mode, environment, hostname) {
  return (
    mode === '--apply' &&
    (environment === 'production' ||
      environment === 'preview' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(hostname))
  )
}

async function main() {
  const mode = process.argv[2]
  if (!['--check', '--apply'].includes(mode) || process.argv.length > 4)
    throw new Error('Use --check or --apply, with --production for production')
  if (process.env.VERCEL_ENV) throw new Error('Run from a protected operator environment')
  const tier = rotationTierFor(process.env.APP_DATABASE_ENV)
  if (tier === 'PRODUCTION' && process.argv[3] !== '--production')
    throw new Error('Production requires --production')
  if (tier !== 'PRODUCTION' && process.argv[3]) throw new Error('Unexpected argument')
  const direct = process.env.DIRECT_URL
  if (!direct) throw new Error('DIRECT_URL is required')
  const url = new URL(direct)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname.includes('-pooler.'))
    throw new Error('DIRECT_URL must be a direct PostgreSQL connection')
  const databaseTarget = directDatabaseTarget(url)
  const activeVersion = Number(process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION)
  if (!Number.isSafeInteger(activeVersion) || activeVersion < 1)
    throw new Error('Invalid active key version')
  keyFor(activeVersion)
  const deploymentOrigin = process.env.CREDENTIAL_ROTATION_DEPLOYMENT_ORIGIN
  if (
    requiresDeploymentProof(mode, process.env.APP_DATABASE_ENV, url.hostname) &&
    !deploymentOrigin
  )
    throw new Error('Deployment key verification is required for remote databases')
  const prisma = new PrismaClient({ datasources: { db: { url: direct } } })
  try {
    const identity = await prisma.databaseIdentity.findUnique({ where: { id: 1 } })
    if (identity?.tier !== tier) throw new Error('Database target verification failed')
    const storedVersions = await prisma.integrationCredential.groupBy({
      by: ['encryptionKeyVersion'],
    })
    const verifiedVersions = deploymentOrigin
      ? await verifyDeploymentKeys(
          deploymentOrigin,
          process.env.DB_VERIFY_TOKEN,
          activeVersion,
          storedVersions.map((row) => row.encryptionKeyVersion),
          databaseTarget,
        )
      : new Set()
    let cursor
    let inspected = 0
    let rotated = 0
    for (;;) {
      const rows = await prisma.integrationCredential.findMany({
        take: 100,
        ...(cursor ? { skip: 1, cursor: { connectionId: cursor } } : {}),
        orderBy: { connectionId: 'asc' },
        include: {
          connection: { select: { userId: true, provider: true, authMethod: true } },
        },
      })
      if (rows.length === 0) break
      for (const row of rows) {
        if (deploymentOrigin && !verifiedVersions.has(row.encryptionKeyVersion)) {
          await verifyDeployedKey(
            deploymentOrigin,
            process.env.DB_VERIFY_TOKEN,
            row.encryptionKeyVersion,
            activeVersion,
            databaseTarget,
          )
          verifiedVersions.add(row.encryptionKeyVersion)
        }
        inspected++
        if (row.encryptionKeyVersion === activeVersion) {
          verifyCredential(row)
          continue
        }
        // Verify all required historical keys before each write. A failure leaves
        // remaining rows on the old version; retain old keys and rerun safely.
        const replacement = reencryptCredential(row, activeVersion)
        if (mode === '--apply') {
          const result = await prisma.integrationCredential.updateMany({
            where: {
              connectionId: row.connectionId,
              userId: row.userId,
              encryptionKeyVersion: row.encryptionKeyVersion,
              ciphertext: { equals: row.ciphertext },
            },
            data: replacement,
          })
          rotated += result.count
        } else rotated++
      }
      cursor = rows.at(-1).connectionId
    }
    const remaining = await prisma.integrationCredential.count({
      where: { encryptionKeyVersion: { not: activeVersion } },
    })
    process.stdout.write(
      `${mode === '--check' ? 'Would rotate' : 'Rotated'} ${rotated} of ${inspected} credential records; ${remaining} remain on older versions.\n`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write(
      'Credential rotation failed; keep all historical keys and inspect configuration.\n',
    )
    process.exitCode = 1
  })
}
