export type DatabaseTier = 'NON_PRODUCTION' | 'PRODUCTION'

export function assertDatabaseEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  if (env.VERCEL_ENV !== 'preview' && env.VERCEL_ENV !== 'production') return

  if (env.APP_DATABASE_ENV !== env.VERCEL_ENV) {
    throw new Error('Database environment does not match the Vercel deployment')
  }

  try {
    const url = new URL(env.DATABASE_URL ?? '')
    if (!url.hostname.endsWith('.neon.tech') || !url.hostname.includes('-pooler.')) {
      throw new Error('invalid pooled Neon host')
    }
  } catch {
    throw new Error('Vercel database access requires a pooled Neon URL')
  }
}

export function getExpectedDatabaseTier(
  env: Readonly<Record<string, string | undefined>>,
): DatabaseTier {
  assertDatabaseEnvironment(env)

  if (env.VERCEL_ENV === 'production') return 'PRODUCTION'
  if (env.VERCEL_ENV === 'preview') return 'NON_PRODUCTION'
  if (env.VERCEL_ENV === 'development' && env.APP_DATABASE_ENV === 'development') {
    return 'NON_PRODUCTION'
  }
  if (
    !env.VERCEL_ENV &&
    (env.APP_DATABASE_ENV === 'development' || env.APP_DATABASE_ENV === 'test')
  ) {
    return 'NON_PRODUCTION'
  }

  throw new Error('Database environment is not configured for application access')
}

export function assertDatabaseTier(expected: DatabaseTier, actual: DatabaseTier | null): void {
  if (actual !== expected) {
    throw new Error('Database environment verification failed')
  }
}
