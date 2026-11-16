import { beforeEach, expect, it, vi } from 'vitest'
import { matchingFixture } from './activity-matching.fixtures'

vi.mock('server-only', () => ({}))
const { user, matching, system, missing } = vi.hoisted(() => ({
  user: vi.fn(),
  matching: vi.fn(),
  system: vi.fn(),
  missing: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
}))
vi.mock('../../../access', () => ({ getAppUser: user }))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/activity/matching', () => ({ getActivityMatching: matching }))
vi.mock('@/server/athlete/profile', () => ({ getMeasurementSystem: system }))
vi.mock('next/navigation', () => ({ notFound: missing }))
vi.mock('../../../app-shell', () => ({ AppShell: () => null }))
vi.mock('./matching-controller', () => ({ MatchingController: () => null }))
import Page from './page'
import { OwnedResourceNotFoundError } from '@/server/authorization/ownership'

beforeEach(() => {
  vi.clearAllMocks()
  user.mockResolvedValue({ id: 'verified-owner', role: 'USER', email: null })
  matching.mockResolvedValue(matchingFixture())
  system.mockResolvedValue('METRIC')
})
const props = () => ({
  params: Promise.resolve({ id: matchingFixture().activityId }),
  searchParams: Promise.resolve({}),
})
it('does not load private matching data for an unavailable session', async () => {
  user.mockResolvedValue(null)
  await Page(props())
  expect(matching).not.toHaveBeenCalled()
})
it('passes only the verified owner and validated date to the matching service', async () => {
  await Page({
    ...props(),
    searchParams: Promise.resolve({ date: '2026-11-20', userId: 'victim' }),
  })
  expect(matching).toHaveBeenCalledWith(expect.objectContaining({ userId: 'verified-owner' }), {
    activityId: matchingFixture().activityId,
    date: '2026-11-20',
  })
})
it('returns not found for a hidden or missing activity without exposing a comparison', async () => {
  matching.mockRejectedValue(new OwnedResourceNotFoundError())
  await expect(Page(props())).rejects.toThrow('NOT_FOUND')
  expect(system).not.toHaveBeenCalled()
})
