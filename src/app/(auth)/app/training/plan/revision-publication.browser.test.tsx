// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RevisionPublication, type PublicationActions } from './revision-publication'
import { publicationPreviewFixture as preview } from './revision-publication.fixtures'
import type { RevisionPublicationPreview } from '@/lib/plan-publication'
import { publicationStatusLabels, type PublicationStatus } from '@/lib/workout-publication'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let host: HTMLDivElement, root: Root, actions: PublicationActions
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  actions = {
    onPreview: vi.fn().mockResolvedValue({ success: true, value: preview }),
    onSend: vi.fn().mockResolvedValue({
      success: true,
      value: {
        id: 'receipt',
        localWorkoutId: preview.changes[0].workoutId,
        status: 'PUBLISHED',
        errorCode: null,
      },
    }),
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((el) => el.textContent === text)!
const click = async (el: HTMLElement) => {
  await act(async () => el.click())
}
async function render() {
  await act(async () =>
    root.render(
      <RevisionPublication {...actions} planId={preview.planId} revisionId={preview.revisionId} />,
    ),
  )
}

it('makes no calls on mount and previews each remote change before individual confirmation', async () => {
  await render()
  expect(actions.onPreview).not.toHaveBeenCalled()
  expect(actions.onSend).not.toHaveBeenCalled()
  await click(button('Review Intervals.icu changes'))
  expect(host.textContent).toContain('CANCEL')
  expect(host.textContent).toContain('RESCHEDULE')
  expect(host.textContent).toContain('CREATE')
  expect(host.textContent).toContain('Before')
  expect(host.textContent).toContain('After')
  expect(button('Confirm cancel in Intervals.icu').disabled).toBe(true)
  await click(button('Confirm cancel in Intervals.icu'))
  expect(actions.onSend).not.toHaveBeenCalled()
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(button('Confirm cancel in Intervals.icu'))
  expect(actions.onSend).toHaveBeenCalledExactlyOnceWith({
    planId: preview.planId,
    expectedRevisionId: preview.revisionId,
    workoutId: preview.changes[0].workoutId,
    reviewToken: preview.changes[0].reviewToken,
    confirm: true,
  })
  expect(host.textContent).toContain('watch delivery unverified')
  expect(button('Confirm cancel in Intervals.icu').disabled).toBe(true)
})
it.each<PublicationStatus>([
  'PUBLISHED',
  'CANCELLED',
  'QUEUED',
  'FAILED',
  'UNCERTAIN',
  'RUNNING',
  'SUPERSEDED',
])('restores the durable %s status after reopening without sending workouts', async (status) => {
  actions.onPreview = vi.fn().mockResolvedValue({
    success: true,
    value: {
      ...preview,
      changes: [],
      workouts: [{ ...preview.workouts[0], status, errorCode: null }],
    },
  })
  await render()
  await click(button('Review Intervals.icu changes'))
  await act(async () => root.unmount())
  root = createRoot(host)
  await render()
  await click(button('Review Intervals.icu changes'))
  const saved = host.querySelector('[aria-label="Saved publication status"]')!
  expect(saved.textContent).toContain(preview.workouts[0].name)
  expect(saved.textContent).toContain(publicationStatusLabels[status])
  expect(saved.textContent).toContain('separate confirmation')
  expect(host.textContent).toContain('No pending changes')
  expect(actions.onSend).not.toHaveBeenCalled()
  expect(host.textContent).toContain('API success does not confirm watch receipt')
})
it('distinguishes local approval and cancellation from provider publication', async () => {
  actions.onPreview = vi.fn().mockResolvedValue({
    success: true,
    value: {
      ...preview,
      workouts: preview.workouts.slice(0, 2).map((workout, index) => ({
        ...workout,
        status: null,
        fromEarlierRevision: false,
        cancelled: index === 1,
      })),
    },
  })
  await render()
  await click(button('Review Intervals.icu changes'))
  const saved = host.querySelector('[aria-label="Saved publication status"]')!
  expect(saved.textContent).toContain('Approved locally · no publication recorded')
  expect(saved.textContent).toContain('Cancelled locally · no publication recorded')
  expect(saved.textContent).not.toContain('Published to Intervals.icu')
  expect(actions.onSend).not.toHaveBeenCalled()
})
it('does not present an earlier publication as confirmation of the current approved date', async () => {
  actions.onPreview = vi.fn().mockResolvedValue({
    success: true,
    value: {
      ...preview,
      workouts: [{ ...preview.workouts[0], status: 'PUBLISHED', fromEarlierRevision: true }],
    },
  })
  await render()
  await click(button('Review Intervals.icu changes'))
  const saved = host.querySelector('[aria-label="Saved publication status"]')!
  expect(saved.textContent).toContain('Approved local date:')
  expect(saved.textContent).toContain('belongs to an earlier approved revision')
  expect(saved.textContent).toContain('does not confirm publication of the current revision')
  expect(actions.onSend).not.toHaveBeenCalled()
})
it('labels unknown remote outcomes without presenting the pending intent as a confirmed before-state', async () => {
  const change = preview.changes[1]
  actions.onPreview = vi.fn().mockResolvedValue({
    success: true,
    value: {
      ...preview,
      changes: [
        {
          ...change,
          baselineStatus: 'unknown',
          before: null,
          remoteStateUncertain: true,
          recovery: { publicationId: 'receipt', publishRevision: 2 },
        },
      ],
    },
  })
  await render()
  await click(button('Review Intervals.icu changes'))
  expect(host.textContent).toContain('previous confirmed schedule is unknown')
  expect(host.textContent).toContain('remote outcome is uncertain')
  expect(host.textContent).not.toContain('Before: last confirmed publication')
  expect(button('Confirm recovery check in Intervals.icu').disabled).toBe(true)
  expect(actions.onSend).not.toHaveBeenCalled()
})
it('shows both sports when the sport is the only change before publication confirmation', async () => {
  const workout = preview.changes[1].after
  const change: RevisionPublicationPreview['changes'][number] = {
    ...preview.changes[1],
    kind: 'changed',
    operation: 'UPDATE',
    before: { ...workout, definition: { ...workout.definition, sport: 'RUNNING' } },
    after: { ...workout, definition: { ...workout.definition, sport: 'CYCLING' } },
  }
  actions.onPreview = vi.fn().mockResolvedValue({
    success: true,
    value: { ...preview, changes: [change] },
  })
  await render()
  await click(button('Review Intervals.icu changes'))
  const diff = host.querySelector('details')!
  const before = diff.querySelectorAll('section')[0]
  const after = diff.querySelectorAll('section')[1]
  expect(before.textContent).toContain('Before')
  expect(before.querySelector('.badge')?.textContent).toBe('running')
  expect(after.textContent).toContain('After')
  expect(after.querySelector('.badge')?.textContent).toBe('cycling')
  expect(button('Confirm update in Intervals.icu').disabled).toBe(true)
  expect(actions.onSend).not.toHaveBeenCalled()
})
it('clears confirmation after a conflict and requires a new review before retry', async () => {
  actions.onSend = vi
    .fn()
    .mockResolvedValue({ success: false, error: 'Plan changed. Reload saved revisions.' })
  await render()
  await click(button('Review Intervals.icu changes'))
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(button('Confirm cancel in Intervals.icu'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Plan changed')
  expect(button('Confirm cancel in Intervals.icu')).toBeUndefined()
  await click(button('Review Intervals.icu changes'))
  expect(button('Confirm cancel in Intervals.icu').disabled).toBe(true)
  expect(actions.onSend).toHaveBeenCalledTimes(1)
})
it('requires separate confirmations for recovery and the subsequent pending change', async () => {
  const change = preview.changes[0]
  actions.onPreview = vi
    .fn()
    .mockResolvedValueOnce({
      success: true,
      value: {
        ...preview,
        changes: [
          {
            ...change,
            status: 'UNCERTAIN',
            recovery: { publicationId: 'receipt', publishRevision: 1 },
          },
        ],
      },
    })
    .mockResolvedValue({ success: true, value: { ...preview, changes: [change] } })
  actions.onSend = vi.fn().mockResolvedValue({
    success: true,
    value: {
      id: 'receipt',
      localWorkoutId: change.workoutId,
      status: 'SUPERSEDED',
      errorCode: null,
    },
  })
  await render()
  await click(button('Review Intervals.icu changes'))
  expect(host.textContent).toContain('earlier publication needs reconciliation')
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(button('Confirm recovery check in Intervals.icu'))
  expect(actions.onSend).toHaveBeenCalledTimes(1)
  expect(button('Confirm cancel in Intervals.icu').disabled).toBe(true)
})
it('offers recovery alone for protected workouts and removes the resolved receipt from pending changes', async () => {
  const change = preview.changes[0]
  actions.onPreview = vi
    .fn()
    .mockResolvedValueOnce({
      success: true,
      value: {
        ...preview,
        changes: [
          {
            ...change,
            status: 'UNCERTAIN',
            recoveryOnly: true,
            recovery: { publicationId: 'receipt', publishRevision: 1 },
          },
        ],
      },
    })
    .mockResolvedValue({ success: true, value: { ...preview, changes: [] } })
  actions.onSend = vi.fn().mockResolvedValue({
    success: true,
    value: {
      id: 'receipt',
      localWorkoutId: change.workoutId,
      status: 'SUPERSEDED',
      errorCode: null,
    },
  })
  await render()
  await click(button('Review Intervals.icu changes'))
  expect(host.textContent).toContain('Only the earlier publication can be reconciled')
  expect(host.textContent).not.toContain('before this change can be queued')
  expect(button('Confirm cancel in Intervals.icu')).toBeUndefined()
  expect(button('Confirm recovery check in Intervals.icu').disabled).toBe(true)
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
  await click(button('Confirm recovery check in Intervals.icu'))
  expect(actions.onSend).toHaveBeenCalledTimes(1)
  expect(button('Confirm recovery check in Intervals.icu')).toBeUndefined()
  expect(host.textContent).toContain('No pending changes')
  expect(host.textContent).toContain('the protected workout was not sent again')
})
