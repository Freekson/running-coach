// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GoalForm } from './goal-form'
import { GoalsScreen } from './goals-screen'
import type { GoalFields, GoalView } from './goal-view'
import { goalInput } from './goal-view'
import type { GoalProgress } from '@/lib/goal-progress'
import { deadlineLabel } from './goal-progress'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}
const goal: GoalView = {
  id: 'synthetic',
  name: 'Finish 83.5 km',
  type: 'COMPLETION',
  distanceKm: '83.5',
  targetTime: '',
  targetDate: '',
  surface: 'TRAIL',
  elevationGainM: '2400',
  sessionsPerWeek: '',
  measurementWindow: 'WEEK',
  archived: false,
}
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  )
  if (!result) throw new Error(`Missing button: ${text}`)
  return result
}

const progress: GoalProgress = {
  status: 'ACTIVE',
  timezone: 'Asia/Tokyo',
  from: null,
  through: '2026-11-14',
  daysRemaining: 2,
  distanceMeters: 68400,
  elevationGainM: 0,
  runCount: 3,
  surfaceUnknownRunCount: 0,
  bestTimeSeconds: 635,
  percent: null,
  achieved: false,
  planCoverage: 'UNAVAILABLE',
}

it('groups overdue with active, exposes achieved and archived tabs, and keeps actions in every footer', async () => {
  const goals: GoalView[] = [
    { ...goal, id: 'active', name: 'Active trail', progress },
    {
      ...goal,
      id: 'overdue',
      name: 'Overdue trail',
      targetDate: '2026-11-10',
      progress: { ...progress, status: 'OVERDUE', daysRemaining: -4 },
    },
    {
      ...goal,
      id: 'achieved',
      name: 'Achieved trail',
      progress: { ...progress, status: 'ACHIEVED', achieved: true },
    },
    {
      ...goal,
      id: 'archived',
      name: 'Archived trail',
      archived: true,
      progress: { ...progress, status: 'ARCHIVED' },
    },
  ]
  await act(async () =>
    root.render(
      <GoalsScreen goals={goals} onSave={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />,
    ),
  )
  expect(host.textContent).toContain('2 active goals')
  expect(host.textContent).not.toContain('Achieved trail')
  expect(host.querySelector('.badge--warning')?.textContent).toBe('Overdue')
  expect(host.textContent).toContain('4 days overdue')
  for (const article of host.querySelectorAll('article')) {
    expect(article.querySelector('footer button[aria-label^="Delete"]')).not.toBeNull()
    expect(article.querySelector('footer button[aria-label^="Archive"]')).not.toBeNull()
    expect(article.querySelector('footer button[aria-label^="Edit"]')).not.toBeNull()
  }
  await act(async () => button('Achieved').click())
  expect(host.textContent).toContain('Achieved trail')
  expect(host.textContent).toContain('Completed')
  expect(host.querySelector<HTMLButtonElement>('footer button[aria-label^="Edit"]')?.disabled).toBe(
    true,
  )
  expect(host.querySelector('article .badge--success')?.textContent).toBe('Achieved')
  expect(host.textContent).not.toContain('Overdue trail')
  expect(button('Achieved').getAttribute('aria-selected')).toBe('true')
  await act(async () =>
    button('Achieved').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ),
  )
  expect(document.activeElement).toBe(button('Archived'))
  expect(host.textContent).toContain('Archived trail')
  expect(host.querySelector<HTMLButtonElement>('footer button[aria-label^="Edit"]')?.disabled).toBe(
    true,
  )
  expect(host.querySelector('footer button[aria-label^="Restore"]')).not.toBeNull()
  await act(async () =>
    button('Archived').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })),
  )
  expect(button('Active').getAttribute('aria-selected')).toBe('true')
  expect(host.querySelector('article .badge--info')?.textContent).toBe('Active')
})

it('does not offer an elevation target when creating a goal', async () => {
  await act(async () => root.render(<GoalForm onSave={vi.fn()} onClose={vi.fn()} />))
  expect(host.textContent).not.toContain('Elevation gain')
})

it('shows actual metrics, accessible progress bars and dates without a calculation section', async () => {
  const goals: GoalView[] = [
    {
      ...goal,
      id: 'performance',
      type: 'PERFORMANCE',
      targetTime: '00:10:00',
      targetDate: '2026-11-16',
      progress,
    },
    { ...goal, id: 'completion', progress },
    {
      ...goal,
      id: 'volume',
      type: 'VOLUME',
      distanceKm: '100',
      elevationGainM: '',
      progress: { ...progress, percent: 68, from: '2026-11-01' },
    },
    {
      ...goal,
      id: 'consistency',
      type: 'CONSISTENCY',
      sessionsPerWeek: '4',
      progress: { ...progress, percent: 75 },
    },
  ]
  await act(async () =>
    root.render(<GoalsScreen goals={goals} onSave={vi.fn()} onArchive={vi.fn()} />),
  )
  for (const text of [
    '10:35',
    '10:00',
    '00:35 to improve',
    'Not completed',
    '68.4',
    '68%',
    '75%',
    '2 days left',
    'Asia/Tokyo',
  ])
    expect(host.textContent).toContain(text)
  expect([...host.querySelectorAll('progress')].map((bar) => bar.value)).toEqual([68, 75])
  expect(host.querySelector('progress')?.getAttribute('aria-label')).toContain('progress')
  expect(host.querySelector('details')).toBeNull()
  expect(host.textContent).not.toContain('How progress is calculated')
})

it('handles deadline copy for today, singular and past days', () => {
  expect([0, 1, 2, -1, -2].map(deadlineLabel)).toEqual([
    'Due today',
    '1 day left',
    '2 days left',
    '1 day overdue',
    '2 days overdue',
  ])
})

it('archives and restores goals, preserves data and shows separate archived content', async () => {
  function Example() {
    const [goals, setGoals] = useState([goal])
    return (
      <GoalsScreen
        goals={goals}
        onSave={vi.fn()}
        onArchive={async (id, archived) => {
          setGoals((previous) =>
            previous.map((item) => (item.id === id ? { ...item, archived } : item)),
          )
        }}
      />
    )
  }
  await act(async () => root.render(<Example />))
  expect(host.textContent).toContain('1 active goal')
  await act(async () => button('Archive').click())
  expect(host.textContent).toContain('0 active goals')
  await act(async () => button('Archived').click())
  expect(host.textContent).toContain(goal.name)
  await act(async () => button('Restore').click())
  expect(host.textContent).toContain('0 archived goals')
  await act(async () => button('Active').click())
  expect(host.textContent).toContain(goal.name)
  expect(host.textContent).not.toContain('Plan constraints')
})

it('keeps the saved card visible when archive fails', async () => {
  await act(async () =>
    root.render(
      <GoalsScreen
        goals={[goal]}
        onSave={vi.fn()}
        onArchive={async () => {
          throw new Error('private DB error')
        }}
      />,
    ),
  )
  await act(async () => button('Archive').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be archived')
  expect(host.textContent).toContain(goal.name)
  expect(host.textContent).not.toContain('private DB error')
})

it('exposes delete on the card without a details dialog and requires confirmation', async () => {
  const remove = vi.fn(async () => {})
  await act(async () =>
    root.render(
      <GoalsScreen goals={[goal]} onSave={vi.fn()} onArchive={vi.fn()} onDelete={remove} />,
    ),
  )
  expect(host.textContent).not.toContain('Goal details')
  expect(host.querySelector('dialog')).toBeNull()
  const deleteButton = host.querySelector<HTMLButtonElement>(
    `button[aria-label="Delete ${goal.name}"]`,
  )!
  await act(async () => deleteButton.click())
  expect(remove).not.toHaveBeenCalled()
  await act(async () => button('Cancel').click())
  expect(remove).not.toHaveBeenCalled()
  await act(async () => deleteButton.click())
  await act(async () => button('Delete goal').click())
  expect(remove).toHaveBeenCalledExactlyOnceWith(goal.id)
})

it('saves a goal without a target time and blocks dismissal while saving', async () => {
  const close = vi.fn()
  let finish: (() => void) | undefined
  const save = vi.fn<(fields: GoalFields) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => root.render(<GoalForm initial={goal} onSave={save} onClose={close} />))
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(goalInput(save.mock.calls[0]?.[0] ?? goal)).toMatchObject({
    targetTimeSeconds: null,
    distanceMeters: 83500,
  })
  expect(button('Cancel').disabled).toBe(true)
  await act(async () =>
    host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
  )
  expect(close).not.toHaveBeenCalled()
  await act(async () => finish?.())
  expect(close).toHaveBeenCalledOnce()
})

it('preserves entered values and exposes a safe error when save fails', async () => {
  const close = vi.fn()
  await act(async () =>
    root.render(
      <GoalForm
        initial={goal}
        onSave={async () => {
          throw new Error('private error')
        }}
        onClose={close}
      />,
    ),
  )
  await act(async () => {
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be saved')
  expect(host.querySelector<HTMLInputElement>('input[required]')?.value).toBe(goal.name)
  expect(close).not.toHaveBeenCalled()
})
