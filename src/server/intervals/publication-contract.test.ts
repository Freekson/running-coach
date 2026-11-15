import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  publicationExternalId,
  publicationPayloadHash,
  publicationPayloadSchema,
} from './publication-contract'
import { approvedPublicationFixture } from './publication.fixtures'

it('hashes the validated canonical snapshot independently of JSON key ordering', () => {
  const { userId, ...source } = approvedPublicationFixture(randomUUID())
  expect(userId).toBeTruthy()
  const original = publicationPayloadSchema.parse(source)
  const reordered = {
    ...original,
    schedule: { timeZone: original.schedule.timeZone, localDate: original.schedule.localDate },
    workout: {
      steps: original.workout.steps,
      sport: original.workout.sport,
      name: original.workout.name,
      schemaVersion: original.workout.schemaVersion,
    },
  }
  expect(publicationPayloadHash(reordered)).toBe(publicationPayloadHash(original))
  expect(
    publicationPayloadHash({
      ...original,
      schedule: { ...original.schedule, localDate: '2027-03-22' },
    }),
  ).not.toBe(publicationPayloadHash(original))
  expect(publicationPayloadHash({ ...original, revisionId: randomUUID() })).not.toBe(
    publicationPayloadHash(original),
  )
})

it('keeps the remote key stable across revisions and distinct for owners sharing an athlete', () => {
  const userA = randomUUID(),
    userB = randomUUID(),
    workoutId = randomUUID()
  expect(publicationExternalId(userA, workoutId)).not.toBe(publicationExternalId(userB, workoutId))
  expect(publicationExternalId(userA, workoutId)).toHaveLength(87)
})

it('hashes undefined optional step names exactly as their persisted JSON representation', () => {
  const { userId, ...source } = approvedPublicationFixture(randomUUID())
  expect(userId).toBeTruthy()
  const definition = publicationPayloadSchema.parse(source)
  definition.workout.steps = [
    {
      type: 'repeat',
      count: 2,
      steps: [
        {
          type: 'step',
          name: undefined,
          termination: { type: 'time', durationSeconds: 600 },
          target: { type: 'free' },
        },
      ],
    },
  ]
  const persisted: unknown = JSON.parse(JSON.stringify(definition))
  expect(publicationPayloadHash(definition)).toBe(
    publicationPayloadHash(publicationPayloadSchema.parse(persisted)),
  )
})
