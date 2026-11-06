import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostnamePattern = /^[a-z0-9-]+\.vercel\.app$/

export function assertProjectProductionDomains(target, hostname, result) {
  if (
    !result ||
    !Array.isArray(result.domains) ||
    typeof result.pagination !== 'object' ||
    result.pagination === null ||
    !Object.hasOwn(result.pagination, 'next') ||
    result.pagination.next !== null ||
    result.domains.some((domain) => typeof domain?.name !== 'string')
  ) {
    throw new Error('Vercel returned an incomplete Production domain list')
  }

  if (result.domains.length === 0) {
    throw new Error('Vercel project has no configured Production domain')
  }
  const matchingDomain = result.domains.find((domain) => domain.name === hostname)
  if (target === 'preview' && matchingDomain) {
    throw new Error('Preview alias matches a Production domain')
  }
  if (target === 'production' && !matchingDomain) {
    throw new Error('Production host is not configured on the Vercel project')
  }
  if (
    target === 'production' &&
    (matchingDomain.verified !== true || matchingDomain.redirect != null)
  ) {
    throw new Error('Production host must be verified and must not redirect')
  }
}

export async function checkVercelDeployDomain(target, env = process.env, fetchImpl = fetch) {
  const hostname = target === 'preview' ? env.VERCEL_PREVIEW_ALIAS : env.VERCEL_PRODUCTION_HOST
  if (
    !['preview', 'production'].includes(target) ||
    !hostnamePattern.test(hostname ?? '') ||
    !env.VERCEL_TOKEN ||
    !env.VERCEL_ORG_ID ||
    !env.VERCEL_PROJECT_ID
  ) {
    throw new Error('Vercel deployment settings are not configured')
  }

  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}/domains`,
  )
  url.searchParams.set('production', 'true')
  url.searchParams.set('limit', '100')
  if (env.VERCEL_ORG_ID.startsWith('team_')) {
    url.searchParams.set('teamId', env.VERCEL_ORG_ID)
  }

  let result
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
    })
    if (!response.ok) {
      throw new Error('Vercel API request failed')
    }
    result = await response.json()
  } catch {
    throw new Error('Could not read Vercel project Production domains')
  }
  assertProjectProductionDomains(target, hostname, result)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkVercelDeployDomain(process.argv[2]).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
