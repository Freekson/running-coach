import 'server-only'

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

export class CredentialUnavailableError extends Error {
  constructor() {
    super('Provider credential unavailable')
  }
}

function keyForVersion(version: number): Buffer {
  const encoded = process.env[`CREDENTIAL_ENCRYPTION_KEY_V${version}`]
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new CredentialUnavailableError()
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded)
    throw new CredentialUnavailableError()
  return key
}

export function activeKeyVersion(): number {
  const value = process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
  const version = value && /^[1-9]\d*$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(version)) throw new CredentialUnavailableError()
  keyForVersion(version)
  return version
}

// A random challenge proves that an operator and a deployed app hold the same
// versioned key without sending the key or a stored credential over the network.
export function proveKeyVersion(
  version: number,
  challenge: Uint8Array,
  databaseTarget: string,
): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new CredentialUnavailableError()
  return createHmac('sha256', keyForVersion(version))
    .update('running-coach:credential-rotation:v2:')
    .update(challenge)
    .update(databaseTarget)
    .digest('base64url')
}

function associatedData(userId: string, connectionId: string, provider: string) {
  return Buffer.from(`${userId}:${connectionId}:${provider}:API_KEY`, 'utf8')
}

export function encryptCredential(
  plaintext: string,
  userId: string,
  connectionId: string,
  provider: string,
) {
  const encryptionKeyVersion = activeKeyVersion()
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyForVersion(encryptionKeyVersion), nonce)
  cipher.setAAD(associatedData(userId, connectionId, provider))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    encryptionKeyVersion,
    rotatedAt: new Date(),
  }
}

export function decryptCredential(
  encrypted: {
    ciphertext: Uint8Array
    nonce: Uint8Array
    authTag: Uint8Array
    encryptionKeyVersion: number
  },
  userId: string,
  connectionId: string,
  provider: string,
): string {
  try {
    if (encrypted.nonce.length !== 12 || encrypted.authTag.length !== 16)
      throw new CredentialUnavailableError()
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyForVersion(encrypted.encryptionKeyVersion),
      encrypted.nonce,
    )
    decipher.setAAD(associatedData(userId, connectionId, provider))
    decipher.setAuthTag(Buffer.from(encrypted.authTag))
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new CredentialUnavailableError()
  }
}
