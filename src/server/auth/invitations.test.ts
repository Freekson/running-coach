import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getPrismaClient,
  updateMany,
  findInvitation,
  findUser,
  findAccount,
  findSession,
  findAppUser,
  deleteUser,
  queryRaw,
} = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  updateMany: vi.fn(),
  findInvitation: vi.fn(),
  findUser: vi.fn(),
  findAccount: vi.fn(),
  findSession: vi.fn(),
  findAppUser: vi.fn(),
  deleteUser: vi.fn(),
  queryRaw: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import {
  completeInvitation,
  consumeInvitation,
  hashInviteToken,
  invitationStatus,
  recoverInvitationAfterFailedSignup,
  releaseInvitation,
} from './invitations'

beforeEach(() => {
  vi.clearAllMocks()
  findAccount.mockResolvedValue(null)
  findSession.mockResolvedValue(null)
  findAppUser.mockResolvedValue(null)
  queryRaw.mockResolvedValue([{ id: 'locked' }])
  const tx = {
    authInvitation: { updateMany, findUnique: findInvitation },
    authUser: { findUnique: findUser, delete: deleteUser },
    authAccount: { findFirst: findAccount },
    authSession: { findFirst: findSession },
    user: { findFirst: findAppUser },
    $queryRaw: queryRaw,
  }
  getPrismaClient.mockResolvedValue({
    ...tx,
    $transaction: (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  })
})

describe('invitation claims', () => {
  const token = 'a'.repeat(64)
  const email = 'runner@example.test'
  const nonce = '00000000-0000-4000-8000-000000000001'

  it('rejects malformed tokens without database access', async () => {
    expect(await invitationStatus('invalid')).toBe('invalid')
    expect(await consumeInvitation('invalid', email)).toBeNull()
    expect(getPrismaClient).not.toHaveBeenCalled()
  })

  it('atomically claims once, then finalizes a successful signup', async () => {
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    const claim = await consumeInvitation(token, 'RUNNER@example.test')
    expect(claim).toEqual({
      tokenHash: hashInviteToken(token),
      claimedAt: expect.any(Date),
      email,
      nonce: expect.any(String),
    })
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        tokenHash: hashInviteToken(token),
        claimedAt: null,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { claimedAt: expect.any(Date), claimedEmail: email, claimedNonce: claim?.nonce },
    })
    if (!claim) throw new Error('Expected a claim')
    expect(await completeInvitation(claim)).toBe(true)
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        tokenHash: claim.tokenHash,
        claimedAt: claim.claimedAt,
        claimedEmail: email,
        claimedNonce: claim.nonce,
        consumedAt: null,
      },
      data: {
        consumedAt: expect.any(Date),
        claimedAt: null,
        claimedEmail: null,
        claimedNonce: null,
      },
    })
  })

  it('releases only the matching claim after a known pre-creation failure', async () => {
    const claim = { tokenHash: 'h', claimedAt: new Date(), email, nonce }
    await releaseInvitation(claim)
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: 'h',
        claimedAt: claim.claimedAt,
        claimedEmail: email,
        claimedNonce: nonce,
      },
      data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
    })
  })

  it('reports an active claim as processing without unlocking it', async () => {
    findInvitation
      .mockResolvedValueOnce({
        claimedAt: new Date(),
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      })
      .mockResolvedValueOnce({
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        consumedAt: null,
        claimedAt: new Date(),
      })
    expect(await invitationStatus(token)).toBe('processing')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('recovers an abandoned claim when the account was not created', async () => {
    const stale = new Date(Date.now() - 180_000)
    findInvitation
      .mockResolvedValueOnce({
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      })
      .mockResolvedValueOnce({
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        consumedAt: null,
        claimedAt: null,
      })
    findUser.mockResolvedValue(null)
    expect(await invitationStatus(token)).toBe('valid')
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: hashInviteToken(token),
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      },
      data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
    })
  })

  it('keeps an abandoned claim consumed if an account was created', async () => {
    const stale = new Date(Date.now() - 180_000)
    findInvitation
      .mockResolvedValueOnce({
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      })
      .mockResolvedValueOnce({
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        consumedAt: new Date(),
        claimedAt: null,
      })
    findUser.mockResolvedValue({
      id: 'created-user',
      email,
      invitationClaimNonce: nonce,
    })
    findAccount.mockResolvedValue({ id: 'credential-account' })
    expect(await invitationStatus(token)).toBe('used')
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: hashInviteToken(token),
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      },
      data: {
        claimedAt: null,
        claimedEmail: null,
        claimedNonce: null,
        consumedAt: expect.any(Date),
      },
    })
  })

  it('reopens an abandoned claim after removing a bare partial user', async () => {
    const stale = new Date(Date.now() - 180_000)
    findInvitation
      .mockResolvedValueOnce({
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      })
      .mockResolvedValueOnce({
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        consumedAt: null,
        claimedAt: null,
      })
    findUser.mockResolvedValue({ id: 'orphan', email, invitationClaimNonce: nonce })
    expect(await invitationStatus(token)).toBe('valid')
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: hashInviteToken(token),
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      },
      data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
    })
  })

  it('ignores an account created by another invitation', async () => {
    const stale = new Date(Date.now() - 180_000)
    findInvitation
      .mockResolvedValueOnce({
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      })
      .mockResolvedValueOnce({
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        consumedAt: null,
        claimedAt: null,
      })
    findUser.mockResolvedValue(null)
    expect(await invitationStatus(token)).toBe('valid')
    expect(findUser).toHaveBeenCalledWith({
      where: { invitationClaimNonce: nonce },
      select: { id: true, email: true, invitationClaimNonce: true },
    })
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: hashInviteToken(token),
        claimedAt: stale,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      },
      data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
    })
  })

  it('reconciles a failed response only after verifying the account', async () => {
    const claim = { tokenHash: 'h', claimedAt: new Date(), email, nonce }
    findUser.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'created-user',
      email,
      invitationClaimNonce: nonce,
    })
    findAccount.mockResolvedValue({ id: 'credential-account' })
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    expect(await recoverInvitationAfterFailedSignup(claim)).toBe(true)
    expect(await recoverInvitationAfterFailedSignup(claim)).toBe(false)
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        tokenHash: 'h',
        claimedAt: claim.claimedAt,
        claimedEmail: email,
        claimedNonce: nonce,
        consumedAt: null,
      },
      data: {
        consumedAt: expect.any(Date),
        claimedAt: null,
        claimedEmail: null,
        claimedNonce: null,
      },
    })
  })

  it('releases a failed claim when only another invitation created the email', async () => {
    const claim = { tokenHash: 'h', claimedAt: new Date(), email, nonce }
    findUser.mockResolvedValue(null)
    updateMany.mockResolvedValue({ count: 1 })
    expect(await recoverInvitationAfterFailedSignup(claim)).toBe(true)
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: 'h',
        claimedAt: claim.claimedAt,
        claimedEmail: email,
        claimedNonce: nonce,
      },
      data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
    })
  })

  it('keeps a claim when account verification fails', async () => {
    findUser.mockRejectedValueOnce(new Error('database unavailable'))
    expect(
      await recoverInvitationAfterFailedSignup({
        tokenHash: 'h',
        claimedAt: new Date(),
        email,
        nonce,
      }),
    ).toBe(false)
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('removes a bare user and releases the invitation after partial signup', async () => {
    const claim = { tokenHash: 'h', claimedAt: new Date(), email, nonce }
    findUser.mockResolvedValue({ id: 'orphan', email, invitationClaimNonce: nonce })
    updateMany.mockResolvedValue({ count: 1 })
    expect(await recoverInvitationAfterFailedSignup(claim)).toBe(true)
    expect(queryRaw).toHaveBeenCalledOnce()
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tokenHash: 'h',
        claimedAt: claim.claimedAt,
        claimedEmail: email,
        claimedNonce: nonce,
      },
      data: { claimedAt: null, claimedEmail: null, claimedNonce: null },
    })
  })

  it('keeps the claim if a partial user cannot safely be removed', async () => {
    const claim = { tokenHash: 'h', claimedAt: new Date(), email, nonce }
    findUser.mockResolvedValue({ id: 'orphan', email, invitationClaimNonce: nonce })
    findAccount.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'other-account' })
    expect(await recoverInvitationAfterFailedSignup(claim)).toBe(false)
    expect(deleteUser).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
  })

  it.each(['session', 'app profile'] as const)(
    'never deletes a partial user with a %s',
    async (existingResource) => {
      const claim = { tokenHash: 'h', claimedAt: new Date(), email, nonce }
      findUser.mockResolvedValue({ id: 'orphan', email, invitationClaimNonce: nonce })
      if (existingResource === 'session') findSession.mockResolvedValue({ id: 'session' })
      else findAppUser.mockResolvedValue({ id: 'profile' })
      expect(await recoverInvitationAfterFailedSignup(claim)).toBe(false)
      expect(deleteUser).not.toHaveBeenCalled()
      expect(updateMany).not.toHaveBeenCalled()
    },
  )
})
