import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCurrentUser,
  isVerifiedCurrentUser,
  updateAthleteProfile,
  addWeight,
  getWeightChartReadings,
  getWeightHistoryPage,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isVerifiedCurrentUser: vi.fn(() => true),
  updateAthleteProfile: vi.fn(),
  addWeight: vi.fn(),
  getWeightChartReadings: vi.fn(),
  getWeightHistoryPage: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({
  AccountUnavailableError: class AccountUnavailableError extends Error {},
  getCurrentUser,
  isVerifiedCurrentUser,
}))
vi.mock('@/server/athlete/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/athlete/profile')>()),
  updateAthleteProfile,
  addWeight,
  getWeightChartReadings,
  getWeightHistoryPage,
}))

import { PATCH } from './profile/route'
import { GET, POST } from './weight/route'
import { AccountUnavailableError } from '@/server/auth/current-user'
import { SexRequiredError, WeightRequestConflictError } from '@/server/athlete/profile'

const requestId = '969e52dd-3b4f-48ce-935a-3ad674584a24'

const request = (path: string, method: string, body: unknown, contentType = 'application/json') =>
  new Request(`https://coach.example.test/api/athlete/${path}`, {
    method,
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'athlete-a', role: 'USER' })
  addWeight.mockResolvedValue({
    id: 'reading-a',
    measuredAt: new Date('2026-01-01T00:00:00.000Z'),
    measuredOn: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    value: { toNumber: () => 70 },
  })
  getWeightChartReadings.mockResolvedValue([])
  getWeightHistoryPage.mockResolvedValue({ items: [], page: 1, total: 0, totalPages: 1 })
})

describe('athlete settings APIs', () => {
  it('reads only the session owner weight chart and paginated history', async () => {
    const chart = await GET(
      new Request('https://coach.example.test/api/athlete/weight?view=chart&period=90D'),
    )
    expect(chart.status).toBe(200)
    expect(chart.headers.get('Cache-Control')).toBe('private, no-store')
    expect(getWeightChartReadings).toHaveBeenCalledWith({ userId: 'athlete-a' }, '90D')
    getCurrentUser.mockResolvedValue({ id: 'athlete-b', role: 'ADMIN' })
    const history = await GET(
      new Request(
        'https://coach.example.test/api/athlete/weight?view=history&page=2&userId=athlete-a',
      ),
    )
    expect(history.status).toBe(200)
    expect(getWeightHistoryPage).toHaveBeenCalledWith({ userId: 'athlete-b' }, 2)
    expect(
      (await GET(new Request('https://coach.example.test/api/athlete/weight?view=history&page=0')))
        .status,
    ).toBe(400)
    expect(
      (
        await GET(
          new Request('https://coach.example.test/api/athlete/weight?view=chart&period=BAD'),
        )
      ).status,
    ).toBe(400)
    expect(getWeightHistoryPage).toHaveBeenCalledTimes(1)
    getCurrentUser.mockResolvedValue(null)
    expect(
      (await GET(new Request('https://coach.example.test/api/athlete/weight?view=history&page=1')))
        .status,
    ).toBe(401)
    getCurrentUser.mockRejectedValue(new AccountUnavailableError())
    expect(
      (
        await GET(
          new Request('https://coach.example.test/api/athlete/weight?view=chart&period=ALL'),
        )
      ).status,
    ).toBe(403)
  })

  it('rejects unauthenticated and suspended requests before any write', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await PATCH(request('profile', 'PATCH', { heightCm: 170 }))).status).toBe(401)
    expect(
      (await POST(request('weight', 'POST', { value: 70, unit: 'KG', requestId }))).status,
    ).toBe(401)
    getCurrentUser.mockRejectedValue(new AccountUnavailableError())
    expect((await PATCH(request('profile', 'PATCH', { heightCm: 170 }))).status).toBe(403)
    expect(
      (await POST(request('weight', 'POST', { value: 70, unit: 'KG', requestId }))).status,
    ).toBe(403)
    expect(updateAthleteProfile).not.toHaveBeenCalled()
    expect(addWeight).not.toHaveBeenCalled()
  })

  it('uses each verified session identity, including an admin, and ignores client ownership claims', async () => {
    expect((await PATCH(request('profile', 'PATCH', { displayName: 'Runner' }))).status).toBe(204)
    getCurrentUser.mockResolvedValue({ id: 'athlete-b', role: 'ADMIN' })
    expect(
      (await POST(request('weight', 'POST', { value: 70, unit: 'KG', requestId }))).status,
    ).toBe(201)
    expect(updateAthleteProfile).toHaveBeenCalledWith(
      { userId: 'athlete-a' },
      { displayName: 'Runner' },
    )
    expect(addWeight).toHaveBeenCalledWith(
      { userId: 'athlete-b' },
      { value: 70, unit: 'KG', requestId },
    )
    expect(
      (await PATCH(request('profile', 'PATCH', { userId: 'athlete-b', heightCm: 170 }))).status,
    ).toBe(400)
    expect(
      (
        await POST(
          request('weight', 'POST', { userId: 'athlete-a', value: 70, unit: 'KG', requestId }),
        )
      ).status,
    ).toBe(400)
    expect(updateAthleteProfile).toHaveBeenCalledTimes(1)
    expect(addWeight).toHaveBeenCalledTimes(1)
  })

  it('rejects bad payloads without writing and returns private responses', async () => {
    expect(
      (await PATCH(request('profile', 'PATCH', { defaultTrainingDaysPerWeek: 8 }))).status,
    ).toBe(400)
    expect((await PATCH(request('profile', 'PATCH', { distanceUnit: 'MI' }))).status).toBe(400)
    expect((await PATCH(request('profile', 'PATCH', { weightUnit: 'LB' }))).status).toBe(400)
    expect((await POST(request('weight', 'POST', { value: -2, unit: 'KG' }))).status).toBe(400)
    expect((await PATCH(request('profile', 'PATCH', {}, 'text/plain'))).status).toBe(415)
    expect((await POST(request('weight', 'POST', { value: 70, unit: 'KG' }))).status).toBe(400)
    const response = await POST(request('weight', 'POST', { value: 70, unit: 'KG', requestId }))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({
      id: 'reading-a',
      measuredOn: '2026-01-01',
      valueKg: 70,
    })
    expect(updateAthleteProfile).not.toHaveBeenCalled()
  })

  it('accepts one account-wide measurement system under the session owner', async () => {
    expect(
      (await PATCH(request('profile', 'PATCH', { measurementSystem: 'IMPERIAL' }))).status,
    ).toBe(204)
    expect(updateAthleteProfile).toHaveBeenCalledWith(
      { userId: 'athlete-a' },
      {
        measurementSystem: 'IMPERIAL',
      },
    )
  })

  it('returns a private conflict response when a request ID is reused for another value', async () => {
    addWeight.mockRejectedValue(new WeightRequestConflictError())
    const response = await POST(request('weight', 'POST', { value: 70, unit: 'KG', requestId }))
    expect(response.status).toBe(409)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('requires a sex choice for a profile without one', async () => {
    updateAthleteProfile.mockRejectedValue(new SexRequiredError())
    const response = await PATCH(request('profile', 'PATCH', { heightCm: 170 }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Select male or female before saving the profile',
    })
    expect((await PATCH(request('profile', 'PATCH', { sex: 'OTHER' }))).status).toBe(400)
    expect(updateAthleteProfile).toHaveBeenCalledTimes(1)
  })
})
