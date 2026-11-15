// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkoutBuilder } from './WorkoutBuilder'
import { intervalWorkout, nestedWorkout } from './workout-builder.fixtures'
import { workoutDefinitionSchema } from '@/schemas/workout-definition.v1'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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
  vi.restoreAllMocks()
})

function input(label: string, within: ParentNode = host) {
  const element = [...within.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  )!
  return document.getElementById(element.htmlFor) as HTMLInputElement
}
async function fill(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function button(text: string, within: ParentNode = host) {
  return [...within.querySelectorAll('button')].find((item) => item.textContent === text)!
}
async function click(element: HTMLElement) {
  await act(async () => element.click())
}
async function choose(label: string, option: string, within: ParentNode) {
  const labelNode = [...within.querySelectorAll('span')].find(
    (item) => item.textContent === label && item.id.endsWith('-label'),
  )!
  await click(document.getElementById(labelNode.id.slice(0, -6))!)
  await click(
    [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === option,
    )!,
  )
}
function topSteps() {
  return [...host.querySelectorAll<HTMLElement>('ol[aria-label="Workout steps"] > li')]
}
function previewOrder() {
  return [...host.querySelectorAll('[aria-label="Workout preview"] li > strong')].map(
    (item) => item.textContent,
  )
}

it('constructs and revises five 1000m repeats with recoveries and exports canonical order', async () => {
  const apply = vi.fn()
  await act(async () => root.render(<WorkoutBuilder onApply={apply} />))
  expect(button('Use workout').disabled).toBe(true)
  await fill(input('Workout name'), intervalWorkout.name)
  await click(button('Add warmup'))
  await fill(input('Duration (seconds)', topSteps()[0]), '600')
  await click(button('Add repeat'))
  const repeat = topSteps()[1]
  const children = repeat.querySelectorAll<HTMLElement>('ol[aria-label="Repeat steps"] > li')
  await choose('End step by', 'Distance', children[0])
  await choose('Target', 'Pace', children[0])
  await fill(input('Fast pace', children[0]), '240')
  await fill(input('Slow pace', children[0]), '270')
  await fill(input('Duration (seconds)', children[1]), '120')
  const rootActions = host.querySelector<HTMLElement>('[aria-label="Add workout steps"]')!
  await click(button('Add cooldown', rootActions))
  await fill(input('Duration (seconds)', topSteps()[2]), '600')
  expect(previewOrder()).toEqual(['Warmup', 'Repeat 5 times', 'Work', 'Recovery', 'Cooldown'])
  expect(host.textContent).toContain('50:00–52:30')
  expect(host.textContent).toContain('5 km + unknown')
  await click(button('Use workout'))
  expect(apply).toHaveBeenLastCalledWith(intervalWorkout)
  await fill(input('Repeat count', repeat), '6')
  await click(button('Use workout'))
  const revised = workoutDefinitionSchema.parse(apply.mock.lastCall?.[0])
  expect(revised.steps[1]).toMatchObject({ type: 'repeat', count: 6 })
  expect(host.textContent).toContain('Workout applied.')
})

it('refuses invalid targets inline, suppresses stale preview and recovers after corrections', async () => {
  const apply = vi.fn()
  await act(async () =>
    root.render(<WorkoutBuilder initialDefinition={intervalWorkout} onApply={apply} />),
  )
  const work = topSteps()[1].querySelector<HTMLElement>('ol > li')!
  await fill(input('Fast pace', work), '400')
  expect(input('Slow pace', work).getAttribute('aria-invalid')).toBe('true')
  expect(host.textContent).toContain(
    'Maximum pace seconds per kilometer must be at least the minimum',
  )
  expect(host.querySelector('[aria-label="Workout preview"]')).toBeNull()
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(apply).not.toHaveBeenCalled()
  await fill(input('Fast pace', work), '240')
  await choose('Target', 'Heart rate', work)
  await fill(input('Minimum HR', work), '130.5')
  expect(button('Use workout').disabled).toBe(true)
  await fill(input('Minimum HR', work), '130')
  await fill(input('Maximum HR', work), '301')
  expect(input('Maximum HR', work).getAttribute('aria-invalid')).toBe('true')
  await fill(input('Maximum HR', work), '150')
  expect(button('Use workout').disabled).toBe(false)
  await fill(input('Distance (meters)', work), '')
  expect(host.textContent).toContain('Enter a finite number.')
  expect(input('Distance (meters)', work).getAttribute('aria-describedby')).toContain('-error')
})

it('keeps stable editing focus and preview order when moving and removing nested steps', async () => {
  await act(async () => root.render(<WorkoutBuilder initialDefinition={nestedWorkout} />))
  expect(previewOrder()).toEqual([
    'Warmup',
    'Repeat 2 times',
    'Repeat 5 times',
    'Work',
    'Recovery',
    'Cooldown',
  ])
  await click(host.querySelector<HTMLElement>('[aria-label="Move Cooldown 3 up"]')!)
  expect(previewOrder()).toEqual([
    'Warmup',
    'Cooldown',
    'Repeat 2 times',
    'Repeat 5 times',
    'Work',
    'Recovery',
  ])
  expect(document.activeElement).toBe(input('Step name', topSteps()[1]))
  await click(host.querySelector<HTMLElement>('[aria-label="Remove Warmup 1"]')!)
  expect(document.activeElement).toBe(input('Step name', topSteps()[0]))
  expect(previewOrder()).toEqual([
    'Cooldown',
    'Repeat 2 times',
    'Repeat 5 times',
    'Work',
    'Recovery',
  ])
})

it('bounds nesting and counts and explains empty repeat groups', async () => {
  await act(async () => root.render(<WorkoutBuilder initialDefinition={nestedWorkout} />))
  const addButtons = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (item) => item.textContent === 'Add repeat',
    )
  await click(addButtons()[0])
  expect(addButtons().some((item) => item.disabled)).toBe(true)
  expect(host.textContent).toContain('Maximum of 3 repeat levels reached.')
  const repeat = topSteps()[1]
  await fill(input('Repeat count', repeat), '101')
  expect(button('Download workout JSON').disabled).toBe(true)
  await fill(input('Repeat count', repeat), '2')
  const deepest = repeat.querySelectorAll<HTMLElement>('ol[aria-label="Repeat steps"]')[2]
  await click(button('Remove', deepest))
  await click(button('Remove', deepest))
  expect(button('Download workout JSON').disabled).toBe(true)
  expect(host.querySelector('[aria-label="Workout preview"]')).toBeNull()
})

it('rejects unsupported definitions rather than silently converting their targets', async () => {
  await act(async () =>
    root.render(
      <WorkoutBuilder
        initialDefinition={{
          ...intervalWorkout,
          steps: [
            { type: 'step', termination: { type: 'lap' }, target: { type: 'power', watts: 200 } },
          ],
        }}
      />,
    ),
  )
  expect(host.textContent).toContain('unsupported format, structure or target')
  expect(host.querySelector('form')).toBeNull()
})

it('blocks locked and pending submissions and retains edits after an apply failure', async () => {
  const apply = vi.fn()
  await act(async () =>
    root.render(<WorkoutBuilder initialDefinition={intervalWorkout} locked onApply={apply} />),
  )
  expect(input('Workout name').matches(':disabled')).toBe(true)
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(apply).not.toHaveBeenCalled()
  let reject: (reason: Error) => void = () => {}
  apply.mockImplementation(
    () =>
      new Promise<void>((_, rejectPromise) => {
        reject = rejectPromise
      }),
  )
  await act(async () =>
    root.render(<WorkoutBuilder initialDefinition={intervalWorkout} onApply={apply} />),
  )
  await click(button('Use workout'))
  expect(input('Workout name').matches(':disabled')).toBe(true)
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(apply).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error('Private provider response')))
  expect(host.textContent).toContain('Your edits are still here')
  expect(host.textContent).not.toContain('Private provider response')
  expect(input('Workout name').value).toBe(intervalWorkout.name)
  expect(button('Use workout').disabled).toBe(false)
})

it('downloads only a validated definition without draft IDs or unused form fields', async () => {
  let captured: Blob | undefined
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      captured = blob
      return 'blob:workout'
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await act(async () => root.render(<WorkoutBuilder initialDefinition={intervalWorkout} />))
  await click(button('Download workout JSON'))
  expect(download).toHaveBeenCalledOnce()
  const json = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(captured!)
  })
  expect(JSON.parse(json)).toEqual(intervalWorkout)
})
