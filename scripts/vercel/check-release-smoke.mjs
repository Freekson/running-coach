import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function checkReleaseSmoke(base, token, fetcher = fetch) {
  let origin
  try {
    const url = new URL(base)
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      )
    )
      throw new Error()
    if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new Error()
    origin = url.origin
  } catch {
    throw new Error(
      'Supply a bare HTTPS origin (or local HTTP) and RELEASE_SMOKE_DB_TOKEN of at least 32 bytes.',
    )
  }

  const checks = [
    { name: 'status page', path: '/status', status: 200 },
    { name: 'anonymous session rejected', path: '/api/me', status: 401, private: true },
    { name: 'anonymous admin rejected', path: '/api/admin/operations', status: 401, private: true },
    {
      name: 'private signup',
      path: '/api/auth/sign-up/email',
      status: 403,
      method: 'POST',
      body: '{}',
    },
    {
      name: 'database probe hidden',
      path: '/api/internal/db-verify',
      status: 404,
      method: 'HEAD',
      private: true,
    },
    {
      name: 'database identity verified',
      path: '/api/internal/db-verify',
      status: 204,
      method: 'HEAD',
      private: true,
      token: true,
    },
  ]
  const results = []
  for (const check of checks) {
    try {
      const response = await fetcher(`${origin}${check.path}`, {
        method: check.method ?? 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
        headers: {
          ...(check.token ? { 'x-db-verify-token': token } : {}),
          ...(check.body ? { 'Content-Type': 'application/json', Origin: origin } : {}),
        },
        ...(check.body ? { body: check.body } : {}),
      })
      if (
        response.status !== check.status ||
        (check.private && !response.headers.get('cache-control')?.includes('no-store')) ||
        (check.body && response.headers.get('x-running-coach-error') !== 'invalid-invitation')
      )
        throw new Error()
      // Do not capture bodies, cookies or provider diagnostics in release evidence.
      await response.body?.cancel()
      results.push(check.name)
    } catch {
      throw new Error(
        `Release smoke failed: ${check.name}. Check target, deployment protection and runtime configuration privately.`,
      )
    }
  }
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = await checkReleaseSmoke(process.argv[2], process.env.RELEASE_SMOKE_DB_TOKEN)
    console.info(`Release smoke passed: ${results.join(', ')}.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
