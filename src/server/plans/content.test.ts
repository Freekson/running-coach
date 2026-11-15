import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  localToday,
  mergePlanWorkouts,
  planContentSchema,
  validatePlanContent,
  PlanValidationError,
} from './content'
import { contentFixture, constraintsFixture, definitionFixture } from './fixtures'

vi.mock('server-only', () => ({}))

describe('plan persistence content', () => {
  it('normalizes UUIDs before duplicate validation', () => {
    const c = contentFixture()
    const id = c.workouts[0].workoutId
    c.workouts[0].workoutId = id.toUpperCase()
    expect(planContentSchema.parse(c).workouts[0].workoutId).toBe(id)
    c.workouts.push({ ...c.workouts[0], workoutId: id })
    expect(() => validatePlanContent(planContentSchema.parse(c), constraintsFixture, null)).toThrow(
      'Workout IDs must be unique',
    )
  })

  it.each(['before', 'after'])(
    'rejects retained active sessions %s the revised macro period',
    (position) => {
      const c = contentFixture()
      const old = {
        ...c.workouts[0],
        timezone: 'UTC',
        scheduledDate: position === 'after' ? '2090-01-27' : '2090-01-05',
      }
      if (position === 'after') {
        c.macroPlan.endDate = '2090-01-20'
        c.macroPlan.phases[0].endDate = '2090-01-20'
        c.detailWindow.endDate = '2090-01-14'
      } else {
        c.macroPlan.startDate = '2090-01-10'
        c.macroPlan.phases[0].startDate = '2090-01-10'
        c.detailWindow = { startDate: '2090-01-10', endDate: '2090-02-06' }
      }
      c.workouts = []
      expect(() =>
        mergePlanWorkouts([old], c, constraintsFixture, [], new Date('2089-12-31')),
      ).toThrow('Retained future workouts must be within the macro period')
    },
  )

  it.each(['cancelled', 'completed', 'past'])(
    'preserves %s sessions outside a shortened horizon',
    (state) => {
      const c = contentFixture()
      const old = {
        ...c.workouts[0],
        timezone: 'UTC',
        scheduledDate: '2090-01-27',
        cancelled: state === 'cancelled',
      }
      c.macroPlan.endDate = '2090-01-20'
      c.macroPlan.phases[0].endDate = '2090-01-20'
      c.detailWindow.endDate = '2090-01-14'
      c.workouts = []
      const locks =
        state === 'completed'
          ? [{ id: old.workoutId, completedAt: new Date(), lockedAt: new Date() }]
          : []
      expect(
        mergePlanWorkouts(
          [old],
          c,
          constraintsFixture,
          locks,
          new Date(state === 'past' ? '2090-02-01' : '2089-12-31'),
        ),
      ).toEqual([old])
    },
  )

  it('keeps a full macro strategy and only a near-term detail window', () => {
    const content = planContentSchema.parse(contentFixture())
    expect(() => validatePlanContent(content, constraintsFixture, '2090-03-31')).not.toThrow()
    expect(content.macroPlan.endDate).toBe('2090-03-31')
    expect(content.detailWindow.endDate).toBe('2090-01-28')
  })

  it.each([13, 29])('rejects a %i day window', (days) => {
    const c = contentFixture()
    c.detailWindow.endDate = new Date(Date.UTC(2090, 0, days)).toISOString().slice(0, 10)
    expect(() => validatePlanContent(c, constraintsFixture, null)).toThrow(PlanValidationError)
  })

  it.each(['gap', 'overlap', 'target', 'outside', 'duplicate', 'start', 'definition', 'unknown'])(
    'rejects %s content',
    (kind) => {
      const c = contentFixture()
      if (kind === 'gap') c.macroPlan.phases[0].startDate = '2090-01-02'
      if (kind === 'overlap') c.macroPlan.phases.push({ ...c.macroPlan.phases[0] })
      if (kind === 'target') c.macroPlan.endDate = '2090-03-30'
      if (kind === 'outside') c.workouts[0].scheduledDate = '2090-02-01'
      if (kind === 'duplicate') c.workouts.push({ ...c.workouts[0] })
      if (kind === 'start') c.macroPlan.startDate = '2090-01-02'
      if (kind === 'definition') Object.assign(c.workouts[0].definition, { schemaVersion: 999 })
      if (kind === 'unknown') Object.assign(c, { approved: true })
      expect(() =>
        validatePlanContent(planContentSchema.parse(c), constraintsFixture, '2090-03-31'),
      ).toThrow()
    },
  )

  it('preserves omitted history and cancels omitted mutable future sessions', () => {
    const c = contentFixture()
    const old = { ...c.workouts[0], timezone: 'UTC', scheduledDate: '2090-01-03' }
    const completed = { ...old, workoutId: randomUUID(), scheduledDate: '2090-01-20' }
    const future = { ...old, workoutId: randomUUID(), scheduledDate: '2090-01-21' }
    c.workouts = []
    const result = mergePlanWorkouts(
      [old, completed, future],
      c,
      constraintsFixture,
      [{ id: completed.workoutId, completedAt: new Date(), lockedAt: null }],
      new Date('2090-01-10T12:00:00Z'),
    )
    expect(result.find((w) => w.workoutId === old.workoutId)).toEqual(old)
    expect(result.find((w) => w.workoutId === completed.workoutId)).toEqual(completed)
    expect(result.find((w) => w.workoutId === future.workoutId)?.cancelled).toBe(true)
  })

  it.each(['past', 'today', 'completed', 'locked', 'newPast'])(
    'rejects rewriting %s workouts',
    (kind) => {
      const c = contentFixture()
      const old = { ...c.workouts[0], timezone: 'UTC' }
      c.workouts[0] = { ...old, definition: { ...definitionFixture, name: 'Changed' } }
      const locks = [
        {
          id: old.workoutId,
          completedAt: kind === 'completed' ? new Date() : null,
          lockedAt: kind === 'locked' ? new Date() : null,
        },
      ]
      expect(() =>
        mergePlanWorkouts(
          kind === 'newPast' ? [] : [old],
          c,
          constraintsFixture,
          locks,
          new Date(
            (kind === 'past' || kind === 'newPast'
              ? '2090-01-10'
              : kind === 'today'
                ? old.scheduledDate
                : '2089-12-31') + 'T12:00:00Z',
          ),
        ),
      ).toThrow(PlanValidationError)
    },
  )

  it('extends a window while retaining stable identities and unchanged past definitions', () => {
    const c = contentFixture()
    const old = { ...c.workouts[0], timezone: 'UTC' }
    c.detailWindow = { startDate: '2090-01-15', endDate: '2090-02-11' }
    c.workouts = [{ ...old, scheduledDate: '2090-01-16' }]
    const next = mergePlanWorkouts(
      [old],
      c,
      constraintsFixture,
      [],
      new Date('2089-12-31T12:00:00Z'),
    )
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ workoutId: old.workoutId, scheduledDate: '2090-01-16' })
  })

  it('uses the plan timezone at the date boundary', () => {
    const now = new Date('2090-01-01T15:30:00Z')
    expect(localToday('Asia/Tokyo', now)).toBe('2090-01-02')
    expect(localToday('America/Los_Angeles', now)).toBe('2090-01-01')
  })

  it('cannot unlock a past session by changing the draft timezone', () => {
    const c = contentFixture()
    c.workouts[0].scheduledDate = '2090-01-02'
    const old = { ...c.workouts[0], timezone: 'Asia/Tokyo' }
    c.workouts[0].definition = { ...definitionFixture, name: 'Changed' }
    expect(() =>
      mergePlanWorkouts(
        [old],
        c,
        { ...constraintsFixture, timezone: 'America/Los_Angeles' },
        [],
        new Date('2090-01-01T15:30:00Z'),
      ),
    ).toThrow(PlanValidationError)
  })
})
