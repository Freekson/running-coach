import { describe, expect, it, vi } from 'vitest'
import { bootstrapAdmin, createInvitationMaterial } from './auth-operator.mjs'

describe('trusted operator actions', () => {
  it('creates unique token links and stores only hashes', () => {
    const a = createInvitationMaterial('https://coach.vercel.app')
    const b = createInvitationMaterial('https://coach.vercel.app')
    expect(a.link).toContain('/sign-up#token=')
    expect(a.link).not.toContain(a.tokenHash)
    expect(a.tokenHash).not.toBe(b.tokenHash)
  })

  it('refuses bootstrap when an ADMIN already exists', async () => {
    const update = vi.fn()
    const prisma = {
      $transaction: vi.fn(async (work) => work({ user: { count: async () => 1, update } })),
    }
    await expect(bootstrapAdmin(prisma, 'auth-user')).rejects.toThrow('An ADMIN already exists')
    expect(update).not.toHaveBeenCalled()
  })

  it('promotes only an existing active local account linked to the verified auth ID', async () => {
    const update = vi.fn()
    const prisma = {
      $transaction: vi.fn(async (work) =>
        work({
          user: {
            count: async () => 0,
            findUnique: async () => ({ id: 'internal', status: 'ACTIVE' }),
            update,
          },
          authUser: { findUnique: async () => ({ id: 'auth-user' }) },
        }),
      ),
    }
    await bootstrapAdmin(prisma, 'auth-user')
    expect(update).toHaveBeenCalledWith({ where: { id: 'internal' }, data: { role: 'ADMIN' } })
  })
})
