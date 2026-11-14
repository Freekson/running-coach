// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GoalForm } from './goal-form'
import { GoalsScreen } from './goals-screen'
import type { GoalFields, GoalView } from './goal-view'
import { goalInput } from './goal-view'

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
  await act(async () => button('Active goals').click())
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
