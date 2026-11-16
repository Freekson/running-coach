import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getOwnerContext } from '@/server/authorization/ownership'
import { planContentSchema } from '@/schemas/plan-content.v1'
import { buildImportProposal } from './proposal'
import { fixtureId, fixtureNow, refreshFixture, refreshResponseFixture } from './fixtures'

function scenario() {
  const request = refreshFixture(getOwnerContext({ id: fixtureId(900), role: 'USER', email: null }))
  const response = refreshResponseFixture()
  if (request.mode !== 'refresh' || response.mode !== 'refresh') throw new Error('Wrong fixture')
  const rows = request.currentApprovedRevision.workouts.map((w) => ({
    ...w,
    scheduledDate: new Date(w.scheduledDate),
    workout: {
      completedAt: w.completedAt ? new Date(w.completedAt) : null,
      lockedAt: w.lockedAt ? new Date(w.lockedAt) : null,
      completedActivityId: null,
      completionAt: null,
      completionFromActivity: false,
    },
  }))
  const macro = request.currentApprovedRevision.macroPlan
  const resolve = () =>
    buildImportProposal(rows, response, request.draft.constraints, fixtureNow, macro)
  return { request, response, rows, macro, resolve }
}
describe('RUN-38 persisted refresh proposal', () => {
  it('reports creates, cancellations and unchanged locks while retaining original text and outside history', () => {
    const s = scenario()
    s.rows[1].definition.name = 'Owner-only saved workout narrative'
    s.macro.strategy = 'Owner-only approved strategy'
    const original = structuredClone(s.rows)
    const p = s.resolve()
    expect(p.refresh.changes.map((w) => w.kind)).toEqual(['canceled', 'unchanged', 'created'])
    expect(p.content.macroPlan.strategy).toBe('Owner-only approved strategy')
    expect(p.refresh.schedule[1].definition.name).toBe('Owner-only saved workout narrative')
    expect(p.workouts.find((w) => w.workoutId === fixtureId(202))?.scheduledDate).toBe('2026-11-14')
    expect(p.refresh.retainedOutsideWindow).toBe(1)
    expect(s.rows).toEqual(original)
  })
  it('applies explicit updates to date and steps, preserving the session timezone', () => {
    const s = scenario()
    s.rows[0].timezone = 'Pacific/Honolulu'
    s.response.operations = [
      {
        operation: 'update',
        workoutId: fixtureId(200),
        scheduledDate: '2026-11-20',
        definition: {
          ...s.rows[0].definition,
          name: 'Updated easy run',
          steps: [
            {
              type: 'step',
              termination: { type: 'time', durationSeconds: 1800 },
              target: { type: 'free' },
            },
          ],
        },
      },
    ]
    const p = s.resolve()
    const change = p.refresh.changes.find((w) => w.workoutId === fixtureId(200))!
    expect(change.kind).toBe('changed')
    expect(change.before?.scheduledDate).toBe('2026-11-17')
    expect(change.after).toMatchObject({
      scheduledDate: '2026-11-20',
      timezone: 'Pacific/Honolulu',
      definition: { name: 'Updated easy run' },
    })
    expect(p.refresh.changes.find((w) => w.workoutId === fixtureId(201))?.kind).toBe('unchanged')
  })
  it('preserves omitted editable sessions instead of cancelling them', () => {
    const s = scenario()
    s.response.operations = []
    expect(s.resolve().refresh.changes.every((w) => w.kind === 'unchanged')).toBe(true)
    expect(s.resolve().workouts.filter((w) => !w.cancelled)).toHaveLength(3)
  })
  it.each(['completedAt', 'lockedAt'] as const)(
    'blocks a late %s on an updated workout',
    (field) => {
      const s = scenario()
      s.rows[0].workout[field] = fixtureNow
      expect(s.resolve).toThrow('Past, completed or locked')
    },
  )
  it('retains accumulated cancellation tombstones without exceeding bounded content capacity', () => {
    const s = scenario()
    s.rows.push(
      ...Array.from({ length: 220 }, (_, i) => ({
        ...s.rows[0],
        workoutId: fixtureId(1000 + i),
        cancelled: true,
      })),
    )
    const p = s.resolve()
    expect(() => planContentSchema.parse(p.content)).not.toThrow()
    expect(p.workouts).toHaveLength(224)
    expect(p.workouts.filter((w) => w.cancelled)).toHaveLength(221)
  })
})
