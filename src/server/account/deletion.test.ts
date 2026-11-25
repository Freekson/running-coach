import { expect, it, vi } from 'vitest'

const getPrismaClient = vi.hoisted(() => vi.fn())
vi.mock('server-only', () => ({}))
vi.mock('@/server/db/client', () => ({ getPrismaClient }))

import { InvalidOwnerContextError } from '@/server/authorization/ownership'
import { deleteAccount } from './deletion'
import { exportAccount } from './export'

it('rejects forged owner contexts before touching the database', async () => {
  const owner = { userId: 'another-user' }
  await expect(
    deleteAccount(owner, { confirmation: 'DELETE', providerAccessRevoked: true }),
  ).rejects.toBeInstanceOf(InvalidOwnerContextError)
  await expect(exportAccount(owner)).rejects.toBeInstanceOf(InvalidOwnerContextError)
  expect(getPrismaClient).not.toHaveBeenCalled()
})
