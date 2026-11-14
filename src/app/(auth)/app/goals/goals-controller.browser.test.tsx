// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GoalWithProgress } from '@/lib/goal-progress'
import type { GoalMutation, GoalSnapshot } from '@/lib/goal-snapshot'

const ownerId = '00000000-0000-4000-8000-000000000099'
function snapshot(goals: GoalWithProgress[], version = '100:100:', observedAt = '1'): GoalSnapshot {
  return { ownerId, snapshot: version, observedAt, goals }
}
function mutation<T>(value: T, transactionId = '101'): { success: true } & GoalMutation<T> {
  return {
    success: true,
    value,
    receipt: { ownerId, transactionId, snapshot: `${transactionId}:${transactionId}:` },
  }
}

const actions = vi.hoisted(() => ({
  save: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}))
vi.mock('./actions', () => ({
  saveGoalAction: actions.save,
  archiveGoalAction: actions.archive,
  deleteGoalAction: actions.remove,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: actions.refresh, push: actions.push }),
}))
import { GoalsController } from './goals-controller'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}
const goal: GoalWithProgress = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Existing synthetic goal',
  archived: false,
  type: 'COMPLETION',
  distanceMeters: 17000,
  targetTimeSeconds: null,
  targetCount: null,
  measurementWindow: null,
  targetDate: null,
  surface: 'ANY',
  elevationGainM: null,
  progress: {
    status: 'ACTIVE',
    timezone: 'UTC',
    from: null,
    through: '2026-11-14',
    daysRemaining: null,
    distanceMeters: 0,
    elevationGainM: 0,
    runCount: 0,
    surfaceUnknownRunCount: 0,
    bestTimeSeconds: null,
    percent: null,
    achieved: false,
    planCoverage: 'UNAVAILABLE',
  },
}
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/app/goals')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === text,
  )
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
async function change(suffix: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}

it('opens and cancels create/edit locally, preserving card nodes with no request or route refresh', async () => {
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  const card = host.querySelector('article')
  await act(async () => button('New goal').click())
  expect(host.querySelector('dialog')).not.toBeNull()
  await act(async () => button('Cancel').click())
  await act(async () => button('Edit').click())
  await act(async () => button('Cancel').click())
  expect(host.querySelector('article')).toBe(card)
  expect(host.querySelector('dialog')).toBeNull()
  expect(actions.save).not.toHaveBeenCalled()
  expect(actions.refresh).not.toHaveBeenCalled()
  expect(actions.push).not.toHaveBeenCalled()
  expect(window.location.pathname).toBe('/app/goals')
})

it('accepts changed server goals and progress without remounting cards or refreshing the router', async () => {
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  const card = host.querySelector('article')
  const updated: GoalWithProgress = {
    ...goal,
    name: 'Updated server goal',
    progress: { ...goal.progress, distanceMeters: 12000, daysRemaining: 1 },
  }
  await act(async () =>
    root.render(<GoalsController snapshot={snapshot([updated], '200:200:', '2')} />),
  )
  expect(host.querySelector('article')).toBe(card)
  expect(card?.textContent).toContain(updated.name)
  expect(card?.textContent).not.toContain(goal.name)
  const achieved: GoalWithProgress = {
    ...updated,
    progress: { ...updated.progress, achieved: true, status: 'ACHIEVED' },
  }
  await act(async () =>
    root.render(<GoalsController snapshot={snapshot([achieved], '300:300:', '3')} />),
  )
  expect(host.querySelector('article')).toBeNull()
  await act(async () => button('Achieved').click())
  expect(host.textContent).toContain(updated.name)
  expect(host.textContent).toContain('Completed')
  expect(host.querySelector<HTMLButtonElement>('button[aria-label^="Edit "]')?.disabled).toBe(true)
  expect(actions.save).not.toHaveBeenCalled()
  expect(actions.refresh).not.toHaveBeenCalled()
  expect(actions.push).not.toHaveBeenCalled()
})

it('preserves local saves when the server repeats an unchanged snapshot with new object references', async () => {
  const saved = { ...goal, name: 'Locally saved goal' }
  actions.save.mockResolvedValue(mutation(saved))
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  await act(async () => button('Edit').click())
  await change('name', saved.name)
  await submit()
  const card = host.querySelector('article')
  await act(async () =>
    root.render(
      <GoalsController snapshot={snapshot([{ ...goal, progress: { ...goal.progress } }])} />,
    ),
  )
  expect(host.querySelector('article')).toBe(card)
  expect(card?.textContent).toContain(saved.name)
  expect(host.querySelector('dialog')).toBeNull()
  expect(actions.refresh).not.toHaveBeenCalled()
  expect(actions.push).not.toHaveBeenCalled()
})

it('adds the server-created goal without reloading or replacing existing cards', async () => {
  const created = {
    ...goal,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'New synthetic goal',
    type: 'PERFORMANCE' as const,
    distanceMeters: 3000,
  }
  actions.save.mockResolvedValue(mutation(created))
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  const existing = host.querySelector('article')
  await act(async () => button('New goal').click())
  await change('name', created.name)
  await change('distance', '3')
  await submit()
  expect(actions.save).toHaveBeenCalledOnce()
  expect(actions.save.mock.calls[0][0]).toMatchObject({
    name: created.name,
    distanceMeters: 3000,
    elevationGainM: null,
  })
  expect(host.querySelectorAll('article')).toHaveLength(2)
  expect(host.querySelectorAll('article')[1]).toBe(existing)
  expect(host.querySelector('dialog')).toBeNull()
  expect(actions.refresh).not.toHaveBeenCalled()
  expect(actions.push).not.toHaveBeenCalled()
})

it('keeps one card when a server payload includes the created goal before its action resolves', async () => {
  const created: GoalWithProgress = {
    ...goal,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Created during refresh',
    type: 'PERFORMANCE',
    distanceMeters: 3000,
  }
  let finish: (() => void) | undefined
  actions.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(mutation(created))
      }),
  )
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  const existingCard = host.querySelector('article')
  await act(async () => button('New goal').click())
  await change('name', created.name)
  await change('distance', '3')
  await submit()
  expect(button('Cancel').disabled).toBe(true)
  await act(async () =>
    root.render(<GoalsController snapshot={snapshot([created, goal], '200:200:', '2')} />),
  )
  const createdCard = host.querySelector(`article[aria-labelledby="goal-${created.id}"]`)
  expect(createdCard).not.toBeNull()
  await act(async () => finish?.())
  expect(host.querySelectorAll('article')).toHaveLength(2)
  expect(host.querySelectorAll(`article[aria-labelledby="goal-${created.id}"]`)).toHaveLength(1)
  expect(host.querySelector(`article[aria-labelledby="goal-${created.id}"]`)).toBe(createdCard)
  expect(host.querySelector(`article[aria-labelledby="goal-${goal.id}"]`)).toBe(existingCard)
  expect(host.textContent).toContain('2 active goals')
  expect(host.querySelector('dialog')).toBeNull()
  expect(actions.save).toHaveBeenCalledOnce()
  expect(actions.refresh).not.toHaveBeenCalled()
  expect(actions.push).not.toHaveBeenCalled()
})

it('retains a successful creation when a stale but changed RSC payload arrives later', async () => {
  const created: GoalWithProgress = {
    ...goal,
    id: 'created-late-read',
    name: 'Confirmed creation',
    type: 'PERFORMANCE',
    distanceMeters: 3000,
  }
  actions.save.mockResolvedValue(mutation(created))
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  await act(async () => button('New goal').click())
  await change('name', created.name)
  await change('distance', '3')
  await submit()
  const card = host.querySelector(`article[aria-labelledby="goal-${created.id}"]`)
  await act(async () =>
    root.render(
      <GoalsController
        snapshot={snapshot([{ ...goal, name: 'Updated existing goal' }], '101:103:101', '2')}
      />,
    ),
  )
  expect(host.querySelectorAll('article')).toHaveLength(2)
  expect(host.querySelector(`article[aria-labelledby="goal-${created.id}"]`)).toBe(card)
  expect(host.textContent).toContain('Updated existing goal')
  expect(host.textContent).toContain(created.name)
  expect(actions.refresh).not.toHaveBeenCalled()
})

it('does not downgrade fresher achieved progress when an older save response resolves', async () => {
  const created: GoalWithProgress = {
    ...goal,
    id: 'created-fresh-read',
    name: 'Fresh achieved goal',
    type: 'PERFORMANCE',
    distanceMeters: 3000,
  }
  let finish: (() => void) | undefined
  actions.save.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(mutation(created))
      }),
  )
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  await act(async () => button('New goal').click())
  await change('name', created.name)
  await change('distance', '3')
  await submit()
  const achieved: GoalWithProgress = {
    ...created,
    progress: { ...created.progress, status: 'ACHIEVED', achieved: true },
  }
  await act(async () =>
    root.render(<GoalsController snapshot={snapshot([achieved, goal], '103:103:', '2')} />),
  )
  await act(async () => finish?.())
  await act(async () => button('Achieved').click())
  expect(host.textContent).toContain(created.name)
  expect(host.querySelector<HTMLButtonElement>('button[aria-label^="Edit "]')?.disabled).toBe(true)
  expect(actions.refresh).not.toHaveBeenCalled()
})

it('keeps a confirmed deletion hidden until a snapshot observes its commit', async () => {
  actions.remove.mockResolvedValue(mutation(null))
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label^="Delete "]')!.click(),
  )
  await act(async () => button('Delete goal').click())
  await act(async () =>
    root.render(
      <GoalsController
        snapshot={snapshot([{ ...goal, name: 'Old record in delayed read' }], '101:103:101', '2')}
      />,
    ),
  )
  expect(host.querySelector('article')).toBeNull()
  await act(async () => root.render(<GoalsController snapshot={snapshot([], '103:103:', '3')} />))
  await act(async () =>
    root.render(<GoalsController snapshot={snapshot([goal], '101:103:101', '4')} />),
  )
  expect(host.querySelector('article')).toBeNull()
  expect(actions.refresh).not.toHaveBeenCalled()
})

it('clears the previous owner’s open editor when the authenticated owner changes', async () => {
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  await act(async () => button('Edit').click())
  expect(host.querySelector<HTMLInputElement>('input[id$="-name"]')?.value).toBe(goal.name)
  await act(async () =>
    root.render(
      <GoalsController snapshot={{ ...snapshot([], '300:300:', '3'), ownerId: 'another-owner' }} />,
    ),
  )
  expect(host.querySelector('dialog')).toBeNull()
  expect(host.textContent).not.toContain(goal.name)
  expect(actions.save).not.toHaveBeenCalled()
  expect(actions.refresh).not.toHaveBeenCalled()
})

it('updates only the saved record and preserves the saved list on failure', async () => {
  actions.save
    .mockResolvedValueOnce({ success: false, error: 'Check the goal fields and try again.' })
    .mockResolvedValueOnce(mutation({ ...goal, name: 'Edited synthetic goal' }))
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  const existing = host.querySelector('article')
  await act(async () => button('Edit').click())
  await change('name', 'Edited synthetic goal')
  await submit()
  expect(existing?.textContent).toContain(goal.name)
  expect(host.querySelector('[role="alert"]')).not.toBeNull()
  await submit()
  expect(host.querySelector('article')).toBe(existing)
  expect(existing?.textContent).toContain('Edited synthetic goal')
  expect(host.querySelector('dialog')).toBeNull()
  expect(actions.refresh).not.toHaveBeenCalled()
})

it('closes a directly loaded creation dialog by replacing the URL without navigation', async () => {
  window.history.replaceState(null, '', '/app/goals/new')
  await act(async () =>
    root.render(<GoalsController snapshot={snapshot([goal])} editor="create" />),
  )
  await act(async () => button('Cancel').click())
  expect(window.location.pathname).toBe('/app/goals')
  expect(actions.push).not.toHaveBeenCalled()
  expect(actions.refresh).not.toHaveBeenCalled()
  expect(actions.save).not.toHaveBeenCalled()
})

it('archives, restores and deletes only the affected record without refreshing the route', async () => {
  actions.archive
    .mockResolvedValueOnce(
      mutation({ ...goal, archived: true, progress: { ...goal.progress, status: 'ARCHIVED' } }),
    )
    .mockResolvedValueOnce(mutation(goal, '102'))
  actions.remove.mockResolvedValue(mutation(null, '103'))
  await act(async () => root.render(<GoalsController snapshot={snapshot([goal])} />))
  await act(async () => button('Archive').click())
  expect(host.querySelector('article')).toBeNull()
  await act(async () => button('Archived').click())
  expect(host.textContent).toContain(goal.name)
  await act(async () => button('Restore').click())
  expect(host.querySelector('article')).toBeNull()
  await act(async () => button('Active').click())
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label^="Delete "]')!.click(),
  )
  await act(async () => button('Delete goal').click())
  expect(host.querySelector('article')).toBeNull()
  expect(actions.archive).toHaveBeenCalledTimes(2)
  expect(actions.remove).toHaveBeenCalledExactlyOnceWith(goal.id)
  expect(actions.refresh).not.toHaveBeenCalled()
  expect(actions.push).not.toHaveBeenCalled()
})
