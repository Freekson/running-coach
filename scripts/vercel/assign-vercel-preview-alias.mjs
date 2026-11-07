import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hostnamePattern = /^[a-z0-9-]+\.vercel\.app$/
const teamSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export async function assignVercelPreviewAlias(
  deploymentUrl,
  env = process.env,
  fetchImpl = fetch,
) {
  const deploymentHostname =
    typeof deploymentUrl === 'string' ? deploymentUrl.replace(/^https:\/\//, '') : ''
  if (
    !hostnamePattern.test(deploymentHostname) ||
    !hostnamePattern.test(env.VERCEL_PREVIEW_ALIAS ?? '') ||
    !teamSlugPattern.test(env.VERCEL_TEAM_SLUG ?? '') ||
    !env.VERCEL_TOKEN
  ) {
    throw new Error('Preview alias assignment settings are not configured')
  }

  const url = new URL(
    `https://api.vercel.com/v2/deployments/${encodeURIComponent(deploymentHostname)}/aliases`,
  )
  url.searchParams.set('slug', env.VERCEL_TEAM_SLUG)

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ alias: env.VERCEL_PREVIEW_ALIAS }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error('Preview alias assignment request failed')
  }
  // A duplicate assignment is safe only if the following read confirms the new deployment.
  if (response.status === 409) {
    console.log('Preview alias assignment returned HTTP 409; checking the current mapping')
    return
  }
  if (!response.ok) {
    throw new Error(`Preview alias assignment failed (HTTP ${response.status})`)
  }

  let result
  try {
    result = await response.json()
  } catch {
    throw new Error('Vercel returned an invalid Preview alias assignment response')
  }
  if (result?.alias !== env.VERCEL_PREVIEW_ALIAS) {
    throw new Error('Vercel returned a different Preview alias')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assignVercelPreviewAlias(process.argv[2])
    .then(() => console.log('Verifying Preview alias deployment mapping'))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
