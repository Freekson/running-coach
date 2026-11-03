import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPrismaClient, updateMany } = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  updateMany: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import { consumeInvitation, hashInviteToken, releaseInvitation } from './invitations'

beforeEach(() => {
  vi.clearAllMocks()
  getPrismaClient.mockResolvedValue({ authInvitation: { updateMany } })
})

describe('invitation consumption', () => {
  it('rejects malformed tokens before database access', async () => {
    await expect(consumeInvitation('invalid')).resolves.toBeNull()
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('uses a hash and a single conditional update for one-time redemption', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const token = 'a'.repeat(64)
    const claim = await consumeInvitation(token)
    expect(claim).toEqual({ tokenHash: hashInviteToken(token), claimedAt: expect.any(Date) })
    expect(await consumeInvitation(token)).toBeNull()
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: hashInviteToken(token),
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { consumedAt: expect.any(Date) },
    })
    if (!claim) throw new Error('Expected a claim')
    await releaseInvitation(claim)
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { tokenHash: hashInviteToken(token), consumedAt: claim.claimedAt },
      data: { consumedAt: null },
    })
  })
})
