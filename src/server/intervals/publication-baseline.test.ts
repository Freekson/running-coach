import { expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { confirmedPublicationPayload, publicationOperation } from './publication-baseline'
import { approvedPublicationFixture } from './publication.fixtures'
import { publicationPayloadSchema } from './publication-contract'

function fixture() {
  const approved = approvedPublicationFixture('00000000-0000-4000-8000-000000000900')
  const payload = publicationPayloadSchema.parse({
    localWorkoutId: approved.localWorkoutId,
    revisionId: approved.revisionId,
    approved: true,
    cancelled: false,
    locked: false,
    workout: approved.workout,
    schedule: approved.schedule,
  })
  return {
    payload,
    receipt: {
      payload,
      lastConfirmedPayload: null,
      status: 'FAILED',
      pendingWrite: null,
      leaseToken: null,
      operation: 'RESCHEDULE',
    },
  }
}
it('keeps the confirmed date separate from a failed or queued reschedule intent', () => {
  const { payload, receipt } = fixture()
  const baseline = { ...payload, schedule: { ...payload.schedule, localDate: '2027-03-20' } }
  for (const status of ['FAILED', 'QUEUED', 'UNCERTAIN']) {
    const confirmed = confirmedPublicationPayload({
      ...receipt,
      status,
      lastConfirmedPayload: baseline,
    })
    expect(confirmed?.schedule.localDate).toBe('2027-03-20')
    expect(publicationOperation(payload, confirmed, receipt)).toBe('RESCHEDULE')
  }
})
it.each(['FAILED', 'QUEUED', 'UNCERTAIN', 'RUNNING', 'SUPERSEDED'])(
  'does not invent a confirmed baseline for a legacy %s intent',
  (status) => {
    const { receipt } = fixture()
    expect(confirmedPublicationPayload({ ...receipt, status })).toBeNull()
  },
)
it('supports settled old-app receipts during rollout but rejects unsettled ones as a baseline', () => {
  const { payload, receipt } = fixture()
  expect(confirmedPublicationPayload({ ...receipt, status: 'PUBLISHED' })).toEqual(payload)
  expect(
    confirmedPublicationPayload({
      ...receipt,
      status: 'PUBLISHED',
      lastConfirmedPayload: {
        ...payload,
        schedule: { ...payload.schedule, localDate: '2027-03-19' },
      },
    }),
  ).toEqual(payload)
  expect(
    confirmedPublicationPayload({
      ...receipt,
      status: 'CANCELLED',
      payload: { ...payload, cancelled: true },
    })?.cancelled,
  ).toBe(true)
  expect(
    confirmedPublicationPayload({
      ...receipt,
      status: 'PUBLISHED',
      pendingWrite: { kind: 'LEGACY' },
    }),
  ).toBeNull()
})
it('retains original retry operations when legacy confirmed state cannot be reconstructed', () => {
  const { payload, receipt } = fixture()
  expect(publicationOperation(payload, null, receipt)).toBe('RESCHEDULE')
  expect(publicationOperation(payload, null, { ...receipt, operation: 'CREATE' })).toBe('CREATE')
  expect(publicationOperation({ ...payload, cancelled: true }, payload, receipt)).toBe('CANCEL')
  expect(publicationOperation(payload, { ...payload, cancelled: true }, receipt)).toBe('CREATE')
})
