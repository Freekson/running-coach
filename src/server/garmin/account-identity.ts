import 'server-only'

import { z } from 'zod'
import type { OwnerContext } from '@/server/authorization/ownership'
import {
  apiKeySchema,
  readProviderApiKeySnapshot,
  saveProviderApiKey,
} from '@/server/provider/vault'
import { requestJson } from './personal-api-poc'

const dailyIdentitySchema = z.object({
  calendarDate: z.iso.date(),
  userProfileId: z.number().int().safe().positive(),
})

export class GarminAccountIdentityError extends Error {
  constructor(readonly code: 'INVALID_KEY' | 'UNVERIFIABLE' | 'RATE_LIMITED') {
    super('Garmin account identity could not be verified')
  }
}

function previousUtcDate(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
}

/** The legacy single-day summary exposes userProfileId; v2 range summaries do not. */
export async function verifyGarminBearerAccount(
  bearer: string,
  options: { fetcher?: typeof fetch; now?: Date; timeoutMs?: number } = {},
): Promise<string> {
  const date = previousUtcDate(options.now ?? new Date())
  const response = await requestJson(
    options.fetcher ?? fetch,
    `/usersummary-service/usersummary/daily?calendarDate=${date}`,
    bearer,
    'GET',
    'json',
    options.timeoutMs,
  )
  if (response.status === 429) throw new GarminAccountIdentityError('RATE_LIMITED')
  if (response.status !== 200) throw new GarminAccountIdentityError('UNVERIFIABLE')
  const parsed = dailyIdentitySchema.safeParse(response.value)
  if (!parsed.success || parsed.data.calendarDate !== date)
    throw new GarminAccountIdentityError('UNVERIFIABLE')
  return String(parsed.data.userProfileId)
}

export async function verifyGarminApiKeyAccount(
  rawKey: string,
  options: { fetcher?: typeof fetch; now?: Date; timeoutMs?: number } = {},
): Promise<string> {
  const key = apiKeySchema.safeParse(rawKey)
  if (!key.success) throw new GarminAccountIdentityError('INVALID_KEY')
  const token = await requestJson(
    options.fetcher ?? fetch,
    '/personalapitoken-service/personal-api/personal-api-key/token',
    `ApiKey ${key.data}`,
    'POST',
    'token',
    options.timeoutMs,
  )
  if (token.status === 429) throw new GarminAccountIdentityError('RATE_LIMITED')
  if (token.status === 401 || token.status === 404)
    throw new GarminAccountIdentityError('INVALID_KEY')
  if (token.status !== 200 || typeof token.value !== 'string' || !token.value)
    throw new GarminAccountIdentityError('UNVERIFIABLE')
  return verifyGarminBearerAccount(`Bearer ${token.value}`, options)
}

/** Verify a saved legacy credential before any account-scoped import begins. */
export async function verifySavedGarminAccount(owner: OwnerContext): Promise<void> {
  const snapshot = await readProviderApiKeySnapshot(owner, 'GARMIN')
  if (snapshot.accountId) return
  const verifiedGarminAccountId = await verifyGarminApiKeyAccount(snapshot.key)
  await saveProviderApiKey(owner, 'GARMIN', snapshot.key, {
    verifiedGarminAccountId,
    expectedCredentialNonce: snapshot.nonce,
  })
}
