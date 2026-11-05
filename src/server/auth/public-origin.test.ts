import { describe, expect, it } from 'vitest'
import { getCanonicalAppOrigin } from './public-origin'

const productionHost = 'running-coach.vercel.app'
const previewHost = 'running-coach-git-development-team.vercel.app'

describe('canonical public application origin', () => {
  it.each([
    [{ BETTER_AUTH_URL: 'http://localhost:3000' }, 'http://localhost:3000'],
    [
      {
        VERCEL_ENV: 'preview',
        APP_DATABASE_ENV: 'preview',
        BETTER_AUTH_URL: `https://${previewHost}`,
        VERCEL_PROJECT_PRODUCTION_URL: productionHost,
        VERCEL_URL: 'running-coach-commit-team.vercel.app',
      },
      `https://${previewHost}`,
    ],
    [
      {
        VERCEL_ENV: 'production',
        APP_DATABASE_ENV: 'production',
        BETTER_AUTH_URL: `https://${productionHost}`,
        VERCEL_PROJECT_PRODUCTION_URL: productionHost,
      },
      `https://${productionHost}`,
    ],
  ])('accepts an environment-scoped origin', (env, expected) => {
    expect(getCanonicalAppOrigin(env).origin).toBe(expected)
  })

  it.each([
    {
      VERCEL_ENV: 'preview',
      APP_DATABASE_ENV: 'preview',
      BETTER_AUTH_URL: `https://${productionHost}`,
      VERCEL_PROJECT_PRODUCTION_URL: productionHost,
    },
    {
      VERCEL_ENV: 'preview',
      APP_DATABASE_ENV: 'production',
      BETTER_AUTH_URL: `https://${previewHost}`,
    },
    {
      VERCEL_ENV: 'production',
      APP_DATABASE_ENV: 'preview',
      BETTER_AUTH_URL: `https://${productionHost}`,
    },
    {
      VERCEL_ENV: 'production',
      APP_DATABASE_ENV: 'production',
      BETTER_AUTH_URL: `https://${previewHost}`,
      VERCEL_PROJECT_PRODUCTION_URL: productionHost,
    },
    {
      VERCEL_ENV: 'preview',
      APP_DATABASE_ENV: 'preview',
      BETTER_AUTH_URL: `https://${previewHost}`,
    },
    {
      VERCEL_ENV: 'preview',
      APP_DATABASE_ENV: 'preview',
      BETTER_AUTH_URL: 'https://running-coach-commit-team.vercel.app',
      VERCEL_URL: 'running-coach-commit-team.vercel.app',
    },
    { BETTER_AUTH_URL: 'http://running-coach.vercel.app' },
    { BETTER_AUTH_URL: 'https://running-coach.vercel.app/sign-up' },
    { BETTER_AUTH_URL: 'https://user:password@running-coach.vercel.app' },
    { BETTER_AUTH_URL: 'https://running-coach.vercel.app?source=other' },
  ])('rejects an unsafe or cross-environment origin', (env) => {
    expect(() => getCanonicalAppOrigin(env)).toThrow()
  })
})
