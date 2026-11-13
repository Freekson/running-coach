import { beforeEach, expect, it, vi } from 'vitest'
const { user, detail, measurement, missing } = vi.hoisted(() => ({
  user: vi.fn(),
  detail: vi.fn(),
  measurement: vi.fn(),
  missing: vi.fn(() => {
    throw new Error('Not found')
  }),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/app/(auth)/app/access', () => ({ getAppUser: user }))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
vi.mock('@/server/activity/detail', () => ({ getActivityDetail: detail }))
vi.mock('@/server/athlete/profile', () => ({ getMeasurementSystem: measurement }))
vi.mock('next/navigation', () => ({ notFound: missing }))
import Page from './page'
import { AppShell } from '../../app-shell'
import { AccountUnavailable } from '../../account-unavailable'
import { ActivityDetailView } from './activity-detail'
import { detailFixture } from './activity-detail.fixtures'
const params = Promise.resolve({ id: detailFixture.id })
beforeEach(() => {
  vi.clearAllMocks()
  user.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', role: 'USER' })
  measurement.mockResolvedValue('METRIC')
  detail.mockResolvedValue(detailFixture)
})
it('renders the saved activity with session ownership and a safe history return link', async () => {
  const page = await Page({
    params,
    searchParams: Promise.resolve({ back: '/app/training?page=2' }),
  })
  expect(page.type).toBe(AppShell)
  expect(page.props.children.type).toBe(ActivityDetailView)
  expect(page.props.children.props.backHref).toBe('/app/training?page=2')
  expect(detail).toHaveBeenCalledWith(
    { userId: '00000000-0000-4000-8000-000000000001' },
    detailFixture.id,
  )
  expect(
    (await Page({ params, searchParams: Promise.resolve({ back: 'https://other.test' }) })).props
      .children.props.backHref,
  ).toBe('/app/training')
})
it('stops anonymous and unsafe routes before reading activity data', async () => {
  user.mockResolvedValueOnce(null)
  expect((await Page({ params })).type).toBe(AccountUnavailable)
  await expect(Page({ params: Promise.resolve({ id: '../unsafe' }) })).rejects.toThrow('Not found')
  expect(detail).not.toHaveBeenCalled()
})
it('returns not-found for another user including an admin rather than disclosing activity existence', async () => {
  user.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000002', role: 'ADMIN' })
  detail.mockResolvedValue(null)
  await expect(Page({ params })).rejects.toThrow('Not found')
  expect(detail).toHaveBeenCalledWith(
    { userId: '00000000-0000-4000-8000-000000000002' },
    detailFixture.id,
  )
})
