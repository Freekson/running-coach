import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  CredentialUnavailableError,
  decryptCredential,
  encryptCredential,
} from './credential-crypto'

const original = {
  version: process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION,
  key1: process.env.CREDENTIAL_ENCRYPTION_KEY_V1,
  key2: process.env.CREDENTIAL_ENCRYPTION_KEY_V2,
}

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1'
  process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 17).toString('base64')
  process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = Buffer.alloc(32, 18).toString('base64')
})

afterEach(() => {
  if (original.version === undefined) delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION
  else process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = original.version
  if (original.key1 === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
  else process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = original.key1
  if (original.key2 === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY_V2
  else process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = original.key2
})

describe('provider credential encryption', () => {
  it('round trips with random nonces and binds ciphertext to owner, connection and provider', () => {
    const secret = 'synthetic-key-for-tests'
    const a = encryptCredential(secret, 'owner-a', 'connection-a', 'OPENAI')
    const b = encryptCredential(secret, 'owner-a', 'connection-a', 'OPENAI')
    expect(a.nonce).not.toEqual(b.nonce)
    expect(a.ciphertext.toString()).not.toContain(secret)
    expect(decryptCredential(a, 'owner-a', 'connection-a', 'OPENAI')).toBe(secret)
    for (const [userId, connectionId, provider] of [
      ['owner-b', 'connection-a', 'OPENAI'],
      ['owner-a', 'connection-b', 'OPENAI'],
      ['owner-a', 'connection-a', 'INTERVALS'],
    ]) {
      expect(() => decryptCredential(a, userId, connectionId, provider)).toThrow(
        CredentialUnavailableError,
      )
    }
    const changed = { ...a, ciphertext: Buffer.from(a.ciphertext) }
    changed.ciphertext[0] ^= 1
    expect(() => decryptCredential(changed, 'owner-a', 'connection-a', 'OPENAI')).toThrow(
      CredentialUnavailableError,
    )
  })

  it('fails closed when active or historical key material is missing', () => {
    const encrypted = encryptCredential('synthetic-key-for-tests', 'a', 'b', 'OPENAI')
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1
    expect(() => encryptCredential('synthetic-key-for-tests', 'a', 'b', 'OPENAI')).toThrow(
      CredentialUnavailableError,
    )
    expect(() => decryptCredential(encrypted, 'a', 'b', 'OPENAI')).toThrow(
      CredentialUnavailableError,
    )
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2'
    const rotated = encryptCredential('synthetic-key-for-tests', 'a', 'b', 'OPENAI')
    expect(rotated.encryptionKeyVersion).toBe(2)
    expect(decryptCredential(rotated, 'a', 'b', 'OPENAI')).toBe('synthetic-key-for-tests')
  })
})
