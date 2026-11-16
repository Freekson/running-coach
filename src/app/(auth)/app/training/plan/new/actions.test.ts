import { beforeEach, expect, it, vi } from 'vitest'
import { RefreshGoalConflictError } from '@/server/plans/transaction'
import { mapWorkoutToIntervals } from '@/server/intervals/workout-mapping'
import { definitionFixture } from '@/server/plans/fixtures'
import type { WorkoutDefinition } from '@/schemas/workout-definition.v1'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  approve: vi.fn(),
  open: vi.fn(),
  revalidate: vi.fn(),
  send: vi.fn(),
  preview: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }))
vi.mock('@/server/auth/current-user', () => ({
  getCurrentUser: mocks.user,
  isVerifiedCurrentUser: () => true,
  AccountUnavailableError: class extends Error {},
}))
vi.mock('@/server/plans/exchange/approve', () => ({ approvePlanImport: mocks.approve }))
vi.mock('@/server/plans/exchange/export', () => ({ openPlanExport: mocks.open }))
vi.mock('@/server/plans/publication', () => ({
  previewRevisionPublication: mocks.preview,
  sendRevisionPublication: mocks.send,
}))
import {
  approveWizardPlanAction,
  openWizardDraftAction,
  openRefreshDraftAction,
  previewRevisionPublicationAction,
  sendRevisionPublicationAction,
} from './actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    role: 'USER',
    email: null,
  })
})
it('requires a verified session for opening and approving', async () => {
  mocks.user.mockResolvedValue(null)
  expect((await openWizardDraftAction({})).success).toBe(false)
  expect((await approveWizardPlanAction({}, '{}')).success).toBe(false)
  expect((await openRefreshDraftAction({})).success).toBe(false)
  expect((await previewRevisionPublicationAction({})).success).toBe(false)
  expect((await sendRevisionPublicationAction({})).success).toBe(false)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.approve).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.preview).not.toHaveBeenCalled()
})
it.each([
  {
    label: 'heart-rate targets',
    workout: {
      ...definitionFixture,
      steps: [
        {
          type: 'step',
          termination: { type: 'time', durationSeconds: 1800 },
          target: { type: 'heartRate', minBpm: 130, maxBpm: 140 },
        },
      ],
    },
    expected: 'Absolute BPM is not supported',
  },
  {
    label: 'unsupported sports',
    workout: { ...definitionFixture, sport: 'CYCLING' },
    expected: 'Only RUNNING workouts are supported',
  },
  {
    label: 'untrusted step cues',
    workout: {
      ...definitionFixture,
      steps: [
        {
          type: 'step',
          name: 'PRIVATE-HEALTH-REPORT 999s',
          termination: { type: 'time', durationSeconds: 1800 },
          target: { type: 'free' },
        },
      ],
    },
    expected: 'Use a step name containing only letters/spaces',
  },
] satisfies { label: string; workout: WorkoutDefinition; expected: string }[])(
  'explains $label without claiming that local approval failed or exposing input',
  async ({ workout, expected }) => {
    mocks.send.mockImplementationOnce(async () =>
      mapWorkoutToIntervals({
        workout,
        schedule: { localDate: '2090-01-05', timeZone: 'UTC' },
        externalId: 'running-coach:synthetic',
      }),
    )
    const result = await sendRevisionPublicationAction({ confirm: true })
    expect(result).toMatchObject({ success: false, error: expect.stringContaining(expected) })
    expect(result).toMatchObject({
      error: expect.stringContaining('Your approved local revision is preserved'),
    })
    expect(result).toMatchObject({
      error: expect.stringContaining('Refresh and explicitly approve a compatible workout'),
    })
    expect(JSON.stringify(result)).not.toContain('The plan could not be saved')
    expect(JSON.stringify(result)).not.toContain('Please try again')
    expect(JSON.stringify(result)).not.toContain('PRIVATE-HEALTH-REPORT')
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.revalidate).not.toHaveBeenCalled()
  },
)
it('preserves actionable new-plan guidance instead of asking to re-export an incompatible goal', async () => {
  mocks.open.mockRejectedValueOnce(new RefreshGoalConflictError())
  const result = await openRefreshDraftAction({
    goalId: '00000000-0000-4000-8000-000000000102',
    planId: '00000000-0000-4000-8000-000000000300',
    expectedRevisionId: '00000000-0000-4000-8000-000000000301',
  })
  expect(result).toEqual({ success: false, error: new RefreshGoalConflictError().message })
})
it('opens only the selected owned plan at its expected approved revision', async () => {
  const input = {
    goalId: '00000000-0000-4000-8000-000000000102',
    planId: '00000000-0000-4000-8000-000000000300',
    expectedRevisionId: '00000000-0000-4000-8000-000000000301',
  }
  await openRefreshDraftAction(input)
  expect(mocks.open).toHaveBeenCalledWith(
    expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001' }),
    { goalId: input.goalId },
    { planId: input.planId, expectedRevisionId: input.expectedRevisionId },
  )
  mocks.open.mockClear()
  expect((await openRefreshDraftAction({ ...input, userId: 'forged' })).success).toBe(false)
  expect(mocks.open).not.toHaveBeenCalled()
})
it('opens an initial draft and derives the owner from the session', async () => {
  await openWizardDraftAction({ userId: 'forged' })
  expect(mocks.open).toHaveBeenCalledWith(
    expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001' }),
    { userId: 'forged' },
    { initialOnly: true },
  )
})
it('revalidates calendar and Training only after successful local approval', async () => {
  mocks.approve.mockResolvedValue({
    approved: false,
    validation: { valid: false, errors: [], repairPrompt: null },
  })
  await approveWizardPlanAction({}, '{}')
  expect(mocks.revalidate).not.toHaveBeenCalled()
  mocks.approve.mockResolvedValue({ approved: true, revisionNumber: 1 })
  await approveWizardPlanAction({ approve: true }, '{}')
  expect(mocks.revalidate.mock.calls).toEqual([['/app/calendar'], ['/app/training']])
})
it('rejects non-text uploads and does not leak infrastructure errors', async () => {
  expect((await approveWizardPlanAction({}, {})).success).toBe(false)
  expect(mocks.approve).not.toHaveBeenCalled()
  mocks.approve.mockRejectedValue(new Error('PRIVATE-DB-SECRET'))
  expect(JSON.stringify(await approveWizardPlanAction({}, '{}'))).not.toContain('PRIVATE')
})
