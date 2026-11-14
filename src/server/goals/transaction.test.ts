import { expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
vi.mock('server-only', () => ({}))
import { goalTransaction, type GoalTransactionRunner } from './transaction'

const conflict = () =>
  new Prisma.PrismaClientKnownRequestError('Synthetic conflict', {
    code: 'P2034',
    clientVersion: 'test',
  })

it('retries aborted serializable writes before returning a successful result', async () => {
  const $transaction = vi
    .fn<GoalTransactionRunner<string>>()
    .mockRejectedValueOnce(conflict())
    .mockResolvedValueOnce('saved')
  const operation = vi.fn(async () => 'saved')
  expect(await goalTransaction({ $transaction }, operation)).toBe('saved')
  expect($transaction).toHaveBeenCalledTimes(2)
  expect($transaction).toHaveBeenLastCalledWith(operation, { isolationLevel: 'Serializable' })
})

it('does not retry authorization, validation or other non-conflict failures', async () => {
  const failure = new Error('Synthetic denied operation')
  const $transaction = vi.fn<GoalTransactionRunner<undefined>>().mockRejectedValue(failure)
  await expect(goalTransaction({ $transaction }, async () => undefined)).rejects.toBe(failure)
  expect($transaction).toHaveBeenCalledTimes(1)
})

it('bounds conflict retries and propagates the last abort without reporting success', async () => {
  const failure = conflict()
  const $transaction = vi.fn<GoalTransactionRunner<undefined>>().mockRejectedValue(failure)
  await expect(goalTransaction({ $transaction }, async () => undefined)).rejects.toBe(failure)
  expect($transaction).toHaveBeenCalledTimes(5)
})
