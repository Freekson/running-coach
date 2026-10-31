import { describe, expect, it } from 'vitest'
import {
  assertDatabaseEnvironment,
  assertDatabaseTier,
  getExpectedDatabaseTier,
} from './environment'

describe('assertDatabaseEnvironment', () => {
  const pooledUrl = 'postgresql://user:secret@ep-test-pooler.us-east-1.aws.neon.tech/db'

  it.each(['preview', 'production'] as const)('accepts a matching %s database', (kind) => {
    expect(() =>
      assertDatabaseEnvironment({
        VERCEL_ENV: kind,
        APP_DATABASE_ENV: kind,
        DATABASE_URL: pooledUrl,
      }),
    ).not.toThrow()
  })

  it.each([
    ['preview', 'production'],
    ['production', 'preview'],
    ['preview', undefined],
    ['production', undefined],
  ] as const)('rejects %s deployment with %s database label', (deployment, database) => {
    expect(() =>
      assertDatabaseEnvironment({
        VERCEL_ENV: deployment,
        APP_DATABASE_ENV: database,
        DATABASE_URL: pooledUrl,
      }),
    ).toThrow('Database environment does not match')
  })

  it.each([
    undefined,
    'postgresql://user:secret@ep-test.us-east-1.aws.neon.tech/db',
    'postgresql://user:secret@localhost:5432/db',
  ])('rejects an unpooled or absent URL in Preview', (databaseUrl) => {
    expect(() =>
      assertDatabaseEnvironment({
        VERCEL_ENV: 'preview',
        APP_DATABASE_ENV: 'preview',
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow('pooled Neon URL')
  })

  it('allows local commands without Vercel environment variables', () => {
    expect(() => assertDatabaseEnvironment({})).not.toThrow()
  })

  it('requires an explicit local nonproduction label before application access', () => {
    expect(() => getExpectedDatabaseTier({})).toThrow('not configured')
    expect(getExpectedDatabaseTier({ APP_DATABASE_ENV: 'development' })).toBe('NON_PRODUCTION')
    expect(getExpectedDatabaseTier({ APP_DATABASE_ENV: 'test' })).toBe('NON_PRODUCTION')
    expect(
      getExpectedDatabaseTier({ VERCEL_ENV: 'development', APP_DATABASE_ENV: 'development' }),
    ).toBe('NON_PRODUCTION')
  })

  it('maps deployed environments to mutually exclusive database tiers', () => {
    expect(
      getExpectedDatabaseTier({
        VERCEL_ENV: 'preview',
        APP_DATABASE_ENV: 'preview',
        DATABASE_URL: pooledUrl,
      }),
    ).toBe('NON_PRODUCTION')
    expect(
      getExpectedDatabaseTier({
        VERCEL_ENV: 'production',
        APP_DATABASE_ENV: 'production',
        DATABASE_URL: pooledUrl,
      }),
    ).toBe('PRODUCTION')
  })

  it('rejects production and preview sharing one marked database', () => {
    expect(() => assertDatabaseTier('PRODUCTION', 'NON_PRODUCTION')).toThrow(
      'Database environment verification failed',
    )
    expect(() => assertDatabaseTier('NON_PRODUCTION', 'PRODUCTION')).toThrow(
      'Database environment verification failed',
    )
    expect(() => assertDatabaseTier('PRODUCTION', null)).toThrow(
      'Database environment verification failed',
    )
    expect(() => assertDatabaseTier('NON_PRODUCTION', 'NON_PRODUCTION')).not.toThrow()
  })
})
