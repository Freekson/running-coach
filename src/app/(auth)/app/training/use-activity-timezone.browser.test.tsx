// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useActivityTimezone } from './use-activity-timezone'
import { activityTimezoneCookie } from '@/lib/activity-history'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  refresh.mockClear()
  document.cookie = `${activityTimezoneCookie}=; Max-Age=0; Path=/`
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
function Scene({ serverZone }: { serverZone: string }) {
  const result = useActivityTimezone(serverZone)
  return <div data-ready={result.ready}>{result.timezone}</div>
}
it('saves the browser timezone and refreshes saved data when the server used a different zone', async () => {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const other = browserZone === 'Asia/Tokyo' ? 'UTC' : 'Asia/Tokyo'
  await act(async () => root.render(<Scene serverZone={other} />))
  expect(document.cookie).toContain(`${activityTimezoneCookie}=${encodeURIComponent(browserZone)}`)
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.querySelector('[data-ready]')?.getAttribute('data-ready')).toBe('false')
  await act(async () => root.render(<Scene serverZone={browserZone} />))
  expect(refresh).toHaveBeenCalledOnce()
  expect(host.querySelector('[data-ready]')?.getAttribute('data-ready')).toBe('true')
})
it('does not refresh a page already filtered in the browser timezone', async () => {
  await act(async () =>
    root.render(<Scene serverZone={Intl.DateTimeFormat().resolvedOptions().timeZone} />),
  )
  expect(refresh).not.toHaveBeenCalled()
})
