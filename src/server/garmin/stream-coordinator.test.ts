import { expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))

import { getOwnerContext } from '@/server/authorization/ownership'
import { createGarminStreamCoordinator, processGarminStreamWork } from './stream-coordinator'

it('dispatches a paginated Activities adapter without changing the coordinator', async () => {
  const owner = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
  const other = getOwnerContext({
    id: '00000000-0000-4000-8000-000000000002',
    role: 'USER',
    email: null,
  })
  const health = vi.fn(async () => 'health unchanged')
  const pages = new Map<string, number>()
  const coordinator = createGarminStreamCoordinator<
    'daily_summary' | 'activities',
    'import' | 'resume',
    string,
    { offset: number; seenIds: string[] }
  >(
    [
      { streamId: 'daily_summary', execute: health },
      {
        streamId: 'activities',
        execute: async (currentOwner, _options, checkpoint) => {
          const offset = pages.get(currentOwner.userId) ?? checkpoint.offset
          pages.set(currentOwner.userId, offset + 1)
          return `${offset}:${checkpoint.seenIds.join(',')}`
        },
      },
    ],
    () => new Error('Unavailable'),
  )
  const options = {
    streamId: 'activities' as const,
    action: 'import' as const,
    browserTimezone: 'UTC',
  }
  expect(await coordinator.run(owner, options, { offset: 0, seenIds: ['42'] })).toBe('0:42')
  expect(
    await coordinator.run(owner, { ...options, action: 'resume' }, { offset: 0, seenIds: [] }),
  ).toBe('1:')
  expect(await coordinator.run(other, options, { offset: 0, seenIds: [] })).toBe('0:')
  expect(health).not.toHaveBeenCalled()
})

it('persists page offsets and seen IDs through the shared bounded work loop', async () => {
  const saved: Array<{ offset: number; seenIds: string[] }> = []
  const result = await processGarminStreamWork({
    checkpoint: { offset: 0, seenIds: [] as string[] },
    maxSteps: 2,
    next: (checkpoint) => checkpoint.offset,
    execute: async (checkpoint, offset) => ({
      checkpoint: {
        offset: offset + 1,
        seenIds: [...checkpoint.seenIds, String(offset + 100)],
      },
      written: true,
    }),
    recover: () => null,
    save: async (step) => {
      saved.push(step.checkpoint)
    },
    shouldStop: () => false,
  })
  expect(saved).toEqual([
    { offset: 1, seenIds: ['100'] },
    { offset: 2, seenIds: ['100', '101'] },
  ])
  expect(result).toMatchObject({ processed: 2, written: 2, checkpoint: saved[1] })
})
