// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActivityMatching, type ActivityMatchingProps } from './activity-matching'
import { matchingFixture } from './activity-matching.fixtures'

let host: HTMLDivElement, root: Root
const link = vi.fn<ActivityMatchingProps['onLink']>(),
  unlink = vi.fn<ActivityMatchingProps['onUnlink']>(),
  reload = vi.fn(),
  search = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  link.mockReset().mockResolvedValue({ success: true, data: undefined })
  unlink.mockReset().mockResolvedValue({ success: true, data: undefined })
  reload.mockReset()
  search.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function render(data = matchingFixture(), refreshing = false) {
  await act(async () =>
    root.render(
      <ActivityMatching
        data={data}
        refreshing={refreshing}
        onLink={link}
        onUnlink={unlink}
        onReload={reload}
        onSearch={search}
      />,
    ),
  )
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find((b) => b.textContent === text)!
}
it('requires explicit confirmation even when a single suggestion is selected', async () => {
  const data = matchingFixture()
  await render(data)
  expect(link).not.toHaveBeenCalled()
  expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true)
  await act(async () => button('Confirm link').click())
  expect(link).toHaveBeenCalledWith({
    activityId: data.activityId,
    expectedWorkoutId: null,
    planId: data.candidates[0].planId,
    expectedRevisionId: data.candidates[0].revisionId,
    workoutId: data.candidates[0].workoutId,
  })
  expect(reload).toHaveBeenCalledOnce()
})
it('does not preselect an ambiguous match and enables confirmation only after user selection', async () => {
  const data = matchingFixture()
  data.ambiguous = true
  data.suggestionWorkoutId = null
  data.candidates.push({ ...data.candidates[0], workoutId: 'second', name: 'Another run' })
  await render(data)
  expect(button('Confirm link').disabled).toBe(true)
  expect(host.textContent).toContain('Multiple sessions are plausible')
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click())
  expect(button('Confirm link').disabled).toBe(false)
  await act(async () => button('Confirm link').click())
  expect(link.mock.calls[0][0].workoutId).toBe('second')
})
it('disables duplicate and pending mutations and exposes failure with reload', async () => {
  const data = matchingFixture()
  data.duplicateLinked = true
  await render(data)
  expect(button('Confirm link').disabled).toBe(true)
  expect(host.querySelector('fieldset')?.disabled).toBe(true)
  await render(matchingFixture(), true)
  expect(button('Confirm link').disabled).toBe(true)
  expect(button('Find sessions').disabled).toBe(true)
  await render()
  link.mockResolvedValue({ success: false, error: 'The plan changed. Reload before continuing.' })
  await act(async () => button('Confirm link').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('The plan changed')
  expect(reload).not.toHaveBeenCalled()
  await act(async () => button('Reload matches').click())
  expect(reload).toHaveBeenCalledOnce()
})
it('shows explicit units and provenance, keeps missing data unavailable, and unlinks with the expected identity', async () => {
  const data = matchingFixture()
  data.linked = { workoutId: data.candidates[0].workoutId, comparison: data.candidates[0] }
  await render(data)
  expect(host.textContent).toContain('Planned vs actual')
  for (const text of [
    'Unavailable',
    's/km',
    'bpm',
    'FIT_LAP',
    'API_ACTIVITY',
    'Asia/Tokyo',
    'permanent schedule locks',
  ])
    expect(host.textContent).toContain(text)
  await act(async () => button('Unlink activity').click())
  expect(unlink).toHaveBeenCalledWith({
    activityId: data.activityId,
    expectedWorkoutId: data.linked.workoutId,
  })
})
it('supports changing the search date and sparse empty states without invoking sync or publication', async () => {
  const data = matchingFixture()
  data.candidates = []
  data.suggestionWorkoutId = null
  data.laps = []
  await render(data)
  expect(host.textContent).toContain('No compatible unlinked sessions found')
  expect(host.textContent).toContain('No saved lap metrics available')
  await act(async () => button('Find sessions').click())
  expect(search).toHaveBeenCalledWith(data.searchDate)
  expect(link).not.toHaveBeenCalled()
})
it('unlinks the blocking legacy duplicate rather than the currently viewed Garmin activity', async () => {
  const data = matchingFixture()
  data.duplicateLinked = true
  data.duplicateCount = 1
  data.suggestionWorkoutId = null
  data.linkedDuplicates = [
    {
      activityId: 'legacy',
      workoutId: 'legacy-workout',
      title: 'Legacy run',
      provider: 'INTERVALS',
    },
  ]
  await render(data)
  expect(button('Confirm link').disabled).toBe(true)
  expect(host.textContent).toContain('Intervals.icu')
  await act(async () => button('Unlink duplicate activity').click())
  expect(unlink).toHaveBeenCalledWith({ activityId: 'legacy', expectedWorkoutId: 'legacy-workout' })
  expect(link).not.toHaveBeenCalled()
  expect(reload).toHaveBeenCalledOnce()
})
it('shows recorded-speed provenance for pace while leaving timer duration unavailable', async () => {
  const data = matchingFixture()
  data.actual = {
    ...data.actual,
    durationSeconds: null,
    durationBasis: 'unavailable',
    paceSecondsPerKm: 333.33,
    paceBasis: 'recorded-speed',
  }
  data.laps[0] = {
    ...data.laps[0],
    durationSeconds: null,
    paceSecondsPerKm: 250,
    paceBasis: 'recorded-speed',
  }
  await render(data)
  expect(host.textContent).toContain('333.33 s/km')
  expect(host.textContent).toContain('Recorded average speed')
  expect(host.textContent).toContain('Timer: Unavailable')
  expect(host.textContent).toContain('250 s/km')
})
