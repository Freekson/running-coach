type PublicOriginEnvironment = Readonly<Record<string, string | undefined>>

export function getCanonicalAppOrigin(env: PublicOriginEnvironment): URL {
  const value = env.BETTER_AUTH_URL
  if (!value) throw new Error('BETTER_AUTH_URL is required')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('BETTER_AUTH_URL must be an absolute origin')
  }

  const isLocal = url.protocol === 'http:' && url.hostname === 'localhost'
  if (
    (url.protocol !== 'https:' && !isLocal) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value !== url.origin
  ) {
    throw new Error('BETTER_AUTH_URL must be a secure origin without a path or credentials')
  }

  if (env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'production') {
    const productionHost = env.VERCEL_PROJECT_PRODUCTION_URL
    if (
      env.APP_DATABASE_ENV !== env.VERCEL_ENV ||
      !url.hostname.endsWith('.vercel.app') ||
      !productionHost
    ) {
      throw new Error('BETTER_AUTH_URL does not match the Vercel environment')
    }
    if (
      env.VERCEL_ENV === 'preview' &&
      (url.hostname === productionHost || url.hostname === env.VERCEL_URL)
    ) {
      throw new Error('Preview BETTER_AUTH_URL must be a stable Preview alias')
    }
    if (env.VERCEL_ENV === 'production' && url.hostname !== productionHost) {
      throw new Error('Production BETTER_AUTH_URL must use the Production domain')
    }
  }

  return url
}
