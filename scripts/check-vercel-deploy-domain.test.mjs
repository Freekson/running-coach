import { describe, expect, it, vi } from 'vitest'
import { checkVercelDeployDomain } from './check-vercel-deploy-domain.mjs'

const shared = {
  VERCEL_TOKEN: 'test-token',
  VERCEL_ORG_ID: 'team_test',
  VERCEL_PROJECT_ID: 'prj_test',
}
const productionDomains = {
  domains: [{ name: 'coach.vercel.app', verified: true }],
  pagination: { next: null },
}

function apiResponse(body = productionDomains) {
  return vi.fn(async () => ({ ok: true, json: async () => body }))
}

describe('Vercel deployment domain guard', () => {
  it('accepts a distinct Preview alias without a Production GitHub variable', async () => {
    const fetchImpl = apiResponse()
    await checkVercelDeployDomain(
      'preview',
      { ...shared, VERCEL_PREVIEW_ALIAS: 'coach-preview.vercel.app' },
      fetchImpl,
    )

    const [url, request] = fetchImpl.mock.calls[0]
    expect(url.pathname).toBe('/v9/projects/prj_test/domains')
    expect(url.searchParams.get('production')).toBe('true')
    expect(url.searchParams.get('teamId')).toBe('team_test')
    expect(request.headers.Authorization).toBe('Bearer test-token')
  })

  it('rejects a Preview alias that is a project Production domain', async () => {
    await expect(
      checkVercelDeployDomain(
        'preview',
        { ...shared, VERCEL_PREVIEW_ALIAS: 'coach.vercel.app' },
        apiResponse(),
      ),
    ).rejects.toThrow('Preview alias matches a Production domain')
  })

  it('accepts only a configured Production host without a Preview GitHub variable', async () => {
    await checkVercelDeployDomain(
      'production',
      { ...shared, VERCEL_PRODUCTION_HOST: 'coach.vercel.app' },
      apiResponse(),
    )
    await expect(
      checkVercelDeployDomain(
        'production',
        { ...shared, VERCEL_PRODUCTION_HOST: 'other.vercel.app' },
        apiResponse(),
      ),
    ).rejects.toThrow('Production host is not configured on the Vercel project')
  })

  it.each([
    ['unverified', { name: 'coach.vercel.app', verified: false }],
    ['redirecting', { name: 'coach.vercel.app', verified: true, redirect: 'other.vercel.app' }],
  ])('rejects a %s Production host', async (_label, domain) => {
    await expect(
      checkVercelDeployDomain(
        'production',
        { ...shared, VERCEL_PRODUCTION_HOST: 'coach.vercel.app' },
        apiResponse({ ...productionDomains, domains: [domain] }),
      ),
    ).rejects.toThrow('Production host must be verified and must not redirect')
  })

  it('fails closed on unavailable or incomplete project domain data', async () => {
    const env = { ...shared, VERCEL_PREVIEW_ALIAS: 'coach-preview.vercel.app' }
    await expect(
      checkVercelDeployDomain(
        'preview',
        env,
        vi.fn(async () => ({ ok: false })),
      ),
    ).rejects.toThrow('Could not read Vercel project Production domains')
    await expect(
      checkVercelDeployDomain(
        'preview',
        env,
        apiResponse({ ...productionDomains, pagination: { next: 123 } }),
      ),
    ).rejects.toThrow('Vercel returned an incomplete Production domain list')
    await expect(
      checkVercelDeployDomain(
        'preview',
        env,
        apiResponse({ ...productionDomains, pagination: {} }),
      ),
    ).rejects.toThrow('Vercel returned an incomplete Production domain list')
  })
})
