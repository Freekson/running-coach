import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostnamePattern = /^[a-z0-9-]+\.vercel\.app$/
const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const retryableStatus = (status) =>
  status === 404 || status === 408 || status === 429 || status >= 500

async function readVercelApi(url, label, request, fetchImpl, waitImpl, matches) {
  let lastFailure = 'request failed'

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response
    try {
      response = await fetchImpl(url, { ...request, signal: AbortSignal.timeout(10_000) })
    } catch {
      lastFailure = 'request failed'
    }

    if (response) {
      if (!response.ok) {
        const status = response.status
        if (!retryableStatus(status)) {
          throw new Error(`Could not verify ${label}: Vercel API returned HTTP ${status}`)
        }
        lastFailure = `Vercel API returned HTTP ${status}`
      } else {
        try {
          const data = await response.json()
          if (matches(data)) return data
          lastFailure = 'alias points to a different deployment or project'
        } catch {
          lastFailure = 'Vercel API returned invalid JSON'
        }
      }
    }

    if (attempt < 4) await waitImpl(1000)
  }

  if (lastFailure === 'alias points to a different deployment or project') {
    throw new Error('Preview alias does not point to the new Vercel deployment')
  }
  throw new Error(`Could not verify ${label}: ${lastFailure}`)
}

export async function verifyVercelPreviewAlias(
  deploymentUrl,
  env = process.env,
  fetchImpl = fetch,
  waitImpl = wait,
) {
  const deploymentHostname =
    typeof deploymentUrl === 'string' ? deploymentUrl.replace(/^https:\/\//, '') : ''
  if (
    !hostnamePattern.test(deploymentHostname ?? '') ||
    !hostnamePattern.test(env.VERCEL_PREVIEW_ALIAS ?? '') ||
    !env.VERCEL_TOKEN ||
    !env.VERCEL_ORG_ID ||
    !env.VERCEL_PROJECT_ID
  ) {
    throw new Error('Preview alias verification settings are not configured')
  }

  const deploymentApi = new URL(
    `https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentHostname)}`,
  )
  deploymentApi.searchParams.set('teamId', env.VERCEL_ORG_ID)
  const aliasApi = new URL(
    `https://api.vercel.com/v4/aliases/${encodeURIComponent(env.VERCEL_PREVIEW_ALIAS)}`,
  )
  aliasApi.searchParams.set('teamId', env.VERCEL_ORG_ID)
  aliasApi.searchParams.set('projectId', env.VERCEL_PROJECT_ID)
  const request = { headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` } }

  const deployment = await readVercelApi(
    deploymentApi,
    'the new Vercel deployment',
    request,
    fetchImpl,
    waitImpl,
    () => true,
  )
  if (typeof deployment?.id !== 'string' || !deployment.id.startsWith('dpl_')) {
    throw new Error('Vercel returned an invalid deployment ID for alias verification')
  }

  await readVercelApi(aliasApi, 'the Preview alias', request, fetchImpl, waitImpl, (mapping) =>
    Boolean(
      mapping?.alias === env.VERCEL_PREVIEW_ALIAS &&
      mapping.projectId === env.VERCEL_PROJECT_ID &&
      mapping.deploymentId === deployment.id &&
      mapping.redirect == null &&
      mapping.deletedAt == null,
    ),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyVercelPreviewAlias(process.argv[2])
    .then(() => console.log('Preview alias points to the new Vercel deployment'))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
