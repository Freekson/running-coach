import { describe, expect, it, vi } from 'vitest'
import { assignVercelPreviewAlias } from './assign-vercel-preview-alias.mjs'

const env = {
  VERCEL_TOKEN: 'test-token',
  VERCEL_TEAM_SLUG: 'freeksons-projects',
  VERCEL_PREVIEW_ALIAS: 'running-coach-dev-freeksons.vercel.app',
}
const deploymentUrl = 'https://running-coach-new-freeksons-projects.vercel.app'
const response = (status, body = { alias: env.VERCEL_PREVIEW_ALIAS }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('Vercel Preview alias assignment', () => {
  it('assigns the configured alias to the new deployment in the verified team scope', async () => {
    const fetchImpl = vi.fn(async () => response(200))

    await assignVercelPreviewAlias(deploymentUrl, env, fetchImpl)

    const [url, request] = fetchImpl.mock.calls[0]
    expect(url.pathname).toBe(
      '/v2/deployments/running-coach-new-freeksons-projects.vercel.app/aliases',
    )
    expect(url.searchParams.get('slug')).toBe('freeksons-projects')
    expect(request.method).toBe('POST')
    expect(request.headers.Authorization).toBe('Bearer test-token')
    expect(request.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(request.body)).toEqual({ alias: env.VERCEL_PREVIEW_ALIAS })
  })

  it('allows a duplicate assignment to proceed to the separate mapping check', async () => {
    await expect(
      assignVercelPreviewAlias(
        deploymentUrl,
        env,
        vi.fn(async () => response(409)),
      ),
    ).resolves.toBeUndefined()
  })

  it('reports permission and request failures without exposing the token', async () => {
    await expect(
      assignVercelPreviewAlias(
        deploymentUrl,
        env,
        vi.fn(async () => response(403)),
      ),
    ).rejects.toThrow('Preview alias assignment failed (HTTP 403)')
    await expect(
      assignVercelPreviewAlias(
        deploymentUrl,
        env,
        vi.fn(async () => {
          throw new Error('private request details')
        }),
      ),
    ).rejects.toThrow('Preview alias assignment request failed')
  })

  it('rejects an unexpected alias or incomplete settings before accepting assignment', async () => {
    await expect(
      assignVercelPreviewAlias(
        deploymentUrl,
        env,
        vi.fn(async () => response(200, { alias: 'other.vercel.app' })),
      ),
    ).rejects.toThrow('Vercel returned a different Preview alias')

    const fetchImpl = vi.fn()
    await expect(
      assignVercelPreviewAlias(deploymentUrl, { ...env, VERCEL_TOKEN: '' }, fetchImpl),
    ).rejects.toThrow('Preview alias assignment settings are not configured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
