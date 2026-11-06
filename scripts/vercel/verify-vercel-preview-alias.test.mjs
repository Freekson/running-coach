import { describe, expect, it, vi } from 'vitest'
import { verifyVercelPreviewAlias } from './verify-vercel-preview-alias.mjs'

const env = {
  VERCEL_TOKEN: 'test-token',
  VERCEL_ORG_ID: 'team_test',
  VERCEL_PROJECT_ID: 'prj_test',
  VERCEL_PREVIEW_ALIAS: 'running-coach-dev-freeksons.vercel.app',
}
const deploymentUrl = 'https://running-coach-new-freeksons-projects.vercel.app'
const deployment = { id: 'dpl_new' }
const mapping = {
  alias: env.VERCEL_PREVIEW_ALIAS,
  projectId: env.VERCEL_PROJECT_ID,
  deploymentId: deployment.id,
}
const apiResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('Vercel Preview alias verification', () => {
  it('accepts only the alias assigned to the new deployment in the expected project', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiResponse(deployment))
      .mockResolvedValueOnce(apiResponse(mapping))

    await verifyVercelPreviewAlias(deploymentUrl, env, fetchImpl)

    const [deploymentApi, deploymentRequest] = fetchImpl.mock.calls[0]
    const [aliasApi, aliasRequest] = fetchImpl.mock.calls[1]
    expect(deploymentApi.pathname).toBe(
      '/v13/deployments/running-coach-new-freeksons-projects.vercel.app',
    )
    expect(aliasApi.pathname).toBe('/v4/aliases/running-coach-dev-freeksons.vercel.app')
    expect(deploymentApi.searchParams.get('teamId')).toBe(env.VERCEL_ORG_ID)
    expect(aliasApi.searchParams.get('teamId')).toBe(env.VERCEL_ORG_ID)
    expect(aliasApi.searchParams.get('projectId')).toBe(env.VERCEL_PROJECT_ID)
    expect(deploymentRequest.headers.Authorization).toBe('Bearer test-token')
    expect(aliasRequest.headers.Authorization).toBe('Bearer test-token')
  })

  it('waits briefly for the alias mapping to become readable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiResponse(deployment))
      .mockResolvedValueOnce(apiResponse({ ...mapping, deploymentId: 'dpl_old' }))
      .mockResolvedValueOnce(apiResponse(mapping))
    const waitImpl = vi.fn(async () => {})

    await verifyVercelPreviewAlias(deploymentUrl, env, fetchImpl, waitImpl)

    expect(waitImpl).toHaveBeenCalledOnce()
  })

  it('retries temporary deployment and alias API failures', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiResponse(null, 429))
      .mockResolvedValueOnce(apiResponse(deployment))
      .mockRejectedValueOnce(new Error('Temporary network failure'))
      .mockResolvedValueOnce(apiResponse(mapping))
    const waitImpl = vi.fn(async () => {})

    await verifyVercelPreviewAlias(deploymentUrl, env, fetchImpl, waitImpl)

    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(waitImpl).toHaveBeenCalledTimes(2)
  })

  it('reports authorization failures without claiming the alias points elsewhere', async () => {
    const deploymentDenied = vi.fn(async () => apiResponse(null, 401))
    await expect(
      verifyVercelPreviewAlias(deploymentUrl, env, deploymentDenied, async () => {}),
    ).rejects.toThrow('Could not verify the new Vercel deployment: Vercel API returned HTTP 401')
    expect(deploymentDenied).toHaveBeenCalledOnce()

    const aliasDenied = vi
      .fn()
      .mockResolvedValueOnce(apiResponse(deployment))
      .mockResolvedValueOnce(apiResponse(null, 403))
    await expect(
      verifyVercelPreviewAlias(deploymentUrl, env, aliasDenied, async () => {}),
    ).rejects.toThrow('Could not verify the Preview alias: Vercel API returned HTTP 403')
    expect(aliasDenied).toHaveBeenCalledTimes(2)
  })

  it('reports an unavailable alias API separately from a mismatched alias', async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.pathname.startsWith('/v13/') ? apiResponse(deployment) : apiResponse(null, 503),
    )

    await expect(
      verifyVercelPreviewAlias(deploymentUrl, env, fetchImpl, async () => {}),
    ).rejects.toThrow('Could not verify the Preview alias: Vercel API returned HTTP 503')
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it.each([
    ['another deployment', { ...mapping, deploymentId: 'dpl_old' }],
    ['another project', { ...mapping, projectId: 'prj_other' }],
    ['a redirect', { ...mapping, redirect: 'other.vercel.app' }],
  ])('rejects an alias pointing to %s', async (_label, wrongMapping) => {
    const fetchImpl = vi.fn(async (url) =>
      apiResponse(url.pathname.startsWith('/v13/') ? deployment : wrongMapping),
    )

    await expect(
      verifyVercelPreviewAlias(deploymentUrl, env, fetchImpl, async () => {}),
    ).rejects.toThrow('Preview alias does not point to the new Vercel deployment')
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it('fails closed when deployment data is unavailable or malformed', async () => {
    await expect(
      verifyVercelPreviewAlias(
        deploymentUrl,
        env,
        vi.fn(async () => apiResponse(null, 503)),
        async () => {},
      ),
    ).rejects.toThrow('Could not verify the new Vercel deployment: Vercel API returned HTTP 503')
    await expect(
      verifyVercelPreviewAlias(
        deploymentUrl,
        env,
        vi.fn(async () => apiResponse({ id: null })),
      ),
    ).rejects.toThrow('invalid deployment ID')
  })
})
