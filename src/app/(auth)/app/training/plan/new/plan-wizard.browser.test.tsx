// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlanWizard, type PlanWizardProps } from './plan-wizard'
import {
  wizardArtifact,
  wizardGoal,
  wizardOwner,
  wizardPreview,
  wizardSaved,
  wizardSetup,
} from './plan-wizard.fixtures'
import { wizardStorageKey } from './wizard-state'
import { estimateWorkout } from '@/lib/workout-estimate'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open')
}
let host: HTMLDivElement, root: Root
let props: PlanWizardProps
beforeEach(() => {
  window.localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  props = {
    ownerId: wizardOwner,
    goals: [wizardGoal],
    onOpen: vi.fn().mockResolvedValue({ success: true, value: wizardSetup }),
    onExport: vi.fn().mockResolvedValue({ success: true, value: wizardArtifact }),
    onSchedule: vi.fn().mockResolvedValue({
      success: true,
      value: { version: 1, constraints: wizardSetup.constraints },
    }),
    onCreateGoal: vi.fn().mockResolvedValue(wizardGoal),
    onPreview: vi.fn().mockResolvedValue({ success: true, value: wizardPreview }),
    onApprove: vi.fn().mockResolvedValue({
      success: true,
      value: { approved: true, revisionNumber: 1, planId: 'plan', revisionId: 'revision' },
    }),
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((el) => el.textContent === text)!
const click = async (el: HTMLElement) => {
  await act(async () => el.click())
}
async function render(saved = wizardSaved) {
  window.localStorage.setItem(wizardStorageKey(wizardOwner), JSON.stringify(saved))
  await act(async () => root.render(<PlanWizard {...props} />))
}
async function enter(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const submit = async () => {
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish
    reject = fail
  })
  return { promise, resolve, reject }
}
async function upload(file: File) {
  const input = host.querySelector<HTMLInputElement>('#plan-response-file')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}

it('preserves the entire saved draft when the current goal is selected again', async () => {
  await render({ ...wizardSaved, step: 1 })
  const before = JSON.parse(window.localStorage.getItem(wizardStorageKey(wizardOwner))!)
  await click(host.querySelector('#wizard-goal')!)
  await click(host.querySelector('[role="option"][aria-selected="true"]')!)
  expect(JSON.parse(window.localStorage.getItem(wizardStorageKey(wizardOwner))!)).toEqual(before)
  await enter(host.querySelector('#sessions')!, '2')
  const edited = JSON.parse(window.localStorage.getItem(wizardStorageKey(wizardOwner))!)
  await click(host.querySelector('#wizard-goal')!)
  await click(host.querySelector('[role="option"][aria-selected="true"]')!)
  expect(JSON.parse(window.localStorage.getItem(wizardStorageKey(wizardOwner))!)).toEqual(edited)
  expect(host.querySelector<HTMLInputElement>('#sessions')?.value).toBe('2')
  expect(button('Save constraints and continue')).toBeDefined()
})

it('waits for a delayed file read and approves only the response that was previewed', async () => {
  const reading = deferred<string>()
  const preview = structuredClone(wizardPreview)
  if (preview.preview.response.mode !== 'initial') throw new Error('Expected initial fixture')
  const workout = preview.preview.response.workouts[0]
  workout.definition.name = 'Replacement 40-minute workout'
  const step = workout.definition.steps[0]
  if (step.type !== 'step' || step.termination.type !== 'time')
    throw new Error('Expected timed step')
  step.termination.durationSeconds = 2400
  preview.preview.sessions[0].estimate = estimateWorkout(workout.definition)
  preview.preview.warnings = []
  preview.preview.review.unacknowledgedWarningIds = []
  preview.preview.review.readyForExplicitApproval = true
  props.onPreview = vi.fn().mockResolvedValue({ success: true, value: preview })
  const replacement = JSON.stringify(preview.preview.response)
  await render()
  const file = new File(['replacement'], 'replacement.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => reading.promise })
  await upload(file)
  expect(button('Validate and preview').disabled).toBe(true)
  expect(button('Back to step 1').disabled).toBe(true)
  expect(host.querySelector<HTMLTextAreaElement>('#plan-response')?.disabled).toBe(true)
  await click(button('Validate and preview'))
  expect(props.onPreview).not.toHaveBeenCalled()
  await act(async () => reading.resolve(replacement))
  expect(host.querySelector<HTMLTextAreaElement>('#plan-response')?.value).toBe(replacement)
  expect(props.onApprove).not.toHaveBeenCalled()
  await click(button('Validate and preview'))
  expect(props.onPreview).toHaveBeenCalledWith(expect.any(Object), replacement)
  expect(host.textContent).toContain('Replacement 40-minute workout')
  expect(host.textContent).toContain('40:00')
  const confirm = [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.includes('I have reviewed'))!
    .querySelector('input')!
  await click(confirm)
  await click(button('Approve locally'))
  expect(props.onApprove).toHaveBeenCalledWith(
    expect.objectContaining({ approve: true }),
    replacement,
  )
})

it('preserves response text and unlocks controls after a failed file read', async () => {
  const reading = deferred<string>()
  await render()
  const file = new File(['unreadable'], 'response.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: () => reading.promise })
  await upload(file)
  expect(button('Validate and preview').disabled).toBe(true)
  await act(async () => reading.reject(new Error('Unreadable file')))
  expect(host.textContent).toContain('The file could not be read')
  expect(host.querySelector<HTMLTextAreaElement>('#plan-response')?.value).toBe(wizardSaved.text)
  expect(button('Validate and preview').disabled).toBe(false)
  expect(button('Back to step 1').disabled).toBe(false)
  expect(props.onApprove).not.toHaveBeenCalled()
})

it('discards a pending preview when its export inputs are invalidated', async () => {
  const checking = deferred<Awaited<ReturnType<PlanWizardProps['onPreview']>>>()
  props.onPreview = vi.fn().mockReturnValue(checking.promise)
  await render()
  await click(button('Validate and preview'))
  const consent = [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.includes('Include my optional training background'))!
    .querySelector('input')!
  await click(consent)
  await act(async () => checking.resolve({ success: true, value: wizardPreview }))
  expect(host.textContent).toContain('Step 2: Export / Chat / Import')
  expect(button('Approve locally')).toBeUndefined()
  expect(props.onApprove).not.toHaveBeenCalled()
})

it('guides a user with no goals through goal creation, constraints, manual exchange and explicit approval', async () => {
  props.goals = []
  await act(async () => root.render(<PlanWizard {...props} />))
  expect(host.textContent).toContain('Step 1: Goal & Constraints')
  await click(button('Create goal'))
  const dialog = host.querySelector('dialog')!
  await enter(dialog.querySelector('input[placeholder^="e.g."]')!, 'First synthetic goal')
  await enter(dialog.querySelector('input[type="number"]')!, '12.345')
  await act(async () =>
    dialog
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(props.onCreateGoal).toHaveBeenCalled()
  await click(button('Open plan draft'))
  await submit()
  expect(host.textContent).toContain('Step 2: Export / Chat / Import')
  expect(props.onExport).not.toHaveBeenCalled()
  await submit()
  expect(button('Copy Prompt')).toBeDefined()
  expect(props.onApprove).not.toHaveBeenCalled()
  await enter(host.querySelector('#plan-response')!, wizardSaved.text)
  await click(button('Validate and preview'))
  expect(host.textContent).toContain('Step 3: Preview / Approve')
  expect(host.textContent).toContain('Gradual base')
  expect(host.textContent).toContain('Rest day')
  expect(host.textContent).toContain('Synthetic easy run')
  const approve = button('Approve locally')
  expect(approve.disabled).toBe(true)
  // Review and approval each have a distinct, visible checkbox.
  const labels = [...host.querySelectorAll('label')].filter((label) => !label.closest('[hidden]'))
  await click(
    labels.find((label) => label.textContent?.includes('I have reviewed'))!.querySelector('input')!,
  )
  expect(approve.disabled).toBe(true)
  await click(
    labels
      .find((label) => label.textContent?.includes('I reviewed this warning'))!
      .querySelector('input')!,
  )
  // Changing acknowledgements requires a fresh explicit confirmation.
  await click(
    labels.find((label) => label.textContent?.includes('I have reviewed'))!.querySelector('input')!,
  )
  await click(approve)
  expect(props.onApprove).toHaveBeenCalledWith(
    expect.objectContaining({
      approve: true,
      acknowledgedWarningIds: [wizardPreview.preview.warnings[0].id],
    }),
    wizardSaved.text,
  )
  expect(host.textContent).toContain('Plan approved locally')
  expect(window.localStorage.getItem(wizardStorageKey(wizardOwner))).toBeNull()
})
it('restores response text after a failed validation and keeps a repair prompt available', async () => {
  props.onPreview = vi.fn().mockResolvedValue({
    success: true,
    value: {
      valid: false,
      errors: [
        {
          path: ['workouts', 0],
          message: 'Invalid workout',
          expected: 'Return a valid canonical workout',
        },
      ],
      repairPrompt: 'Synthetic repair prompt',
    },
  })
  await render()
  await click(button('Validate and preview'))
  expect(host.textContent).toContain('Response needs changes')
  expect(host.querySelector<HTMLTextAreaElement>('#repair-prompt')?.value).toBe(
    'Synthetic repair prompt',
  )
  expect(props.onApprove).not.toHaveBeenCalled()
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => root.render(<PlanWizard {...props} />))
  expect(host.querySelector<HTMLTextAreaElement>('#plan-response')?.value).toBe(wizardSaved.text)
})
it('restores review input but requires revalidation and fresh acknowledgements', async () => {
  await render({ ...wizardSaved, step: 3 })
  expect(button('Approve locally')).toBeUndefined()
  expect(props.onPreview).not.toHaveBeenCalled()
  await click(button('Revalidate saved response'))
  expect(button('Approve locally').disabled).toBe(true)
  expect(props.onApprove).not.toHaveBeenCalled()
})
it('keeps one account draft out of another account session', async () => {
  props.ownerId = 'another-user'
  await render()
  expect(host.textContent).toContain('Step 1: Goal & Constraints')
  expect(host.querySelector('#plan-response')).toBeNull()
})
it('preserves the draft on approval failure and explains storage failures', async () => {
  props.onApprove = vi
    .fn()
    .mockResolvedValue({ success: false, error: 'Draft changed. Reopen and export again.' })
  await render()
  await click(button('Validate and preview'))
  const visibleLabels = [...host.querySelectorAll('label')].filter(
    (label) => !label.closest('[hidden]'),
  )
  await click(
    visibleLabels
      .find((label) => label.textContent?.includes('I reviewed this warning'))!
      .querySelector('input')!,
  )
  await click(
    visibleLabels
      .find((label) => label.textContent?.includes('I have reviewed'))!
      .querySelector('input')!,
  )
  await click(button('Approve locally'))
  expect(host.textContent).toContain('Draft changed')
  expect(JSON.parse(window.localStorage.getItem(wizardStorageKey(wizardOwner))!).text).toBe(
    wizardSaved.text,
  )
  await act(async () => root.unmount())
  root = createRoot(host)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Quota')
  })
  await act(async () => root.render(<PlanWizard {...props} />))
  expect(host.textContent).toContain('Browser storage is unavailable or full')
})

it('persists unsaved constraints and carries the saved version into export', async () => {
  const constraints = { ...wizardSetup.constraints, sessionsPerWeek: 2 }
  props.onSchedule = vi
    .fn()
    .mockResolvedValue({ success: true, value: { version: 1, constraints } })
  await render({ ...wizardSaved, step: 1 })
  await enter(host.querySelector('#sessions')!, '2')
  const stored = JSON.parse(window.localStorage.getItem(wizardStorageKey(wizardOwner))!)
  expect(stored.exportState.constraints.sessionsPerWeek).toBe(2)
  expect(stored.exportState.result).toBeUndefined()
  await submit()
  expect(props.onSchedule).toHaveBeenCalledWith(
    expect.objectContaining({ expectedVersion: 0, constraints }),
  )
  await submit()
  expect(props.onExport).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1 }))
})

it.each([2, 3] as const)(
  'preserves the issued request when returning from step %s through unchanged constraints',
  async (step) => {
    await render({ ...wizardSaved, step })
    if (step === 3) await click(button('Back to step 2'))
    await click(button('Back to step 1'))
    await submit()
    expect(props.onSchedule).not.toHaveBeenCalled()
    expect(props.onExport).not.toHaveBeenCalled()
    expect(button('Copy Prompt')).toBeDefined()
    const saved = JSON.parse(window.localStorage.getItem(wizardStorageKey(wizardOwner))!)
    expect(saved.exportState.result).toEqual(wizardArtifact)
    expect(saved.text).toBe(wizardSaved.text)
    expect(button('Validate and preview').disabled).toBe(false)
    await click(button('Validate and preview'))
    expect(props.onPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: wizardArtifact.requestId,
        draftId: wizardSetup.draftId,
        goalId: wizardGoal.id,
      }),
      wizardSaved.text,
    )
    expect(host.textContent).toContain('Step 3: Preview / Approve')
    expect(props.onApprove).not.toHaveBeenCalled()
  },
)

it('still requires a fresh export after changing the detail window in step 1', async () => {
  await render()
  await click(button('Back to step 1'))
  await click(host.querySelector('#window-length')!)
  await click(
    [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === '21 days',
    )!,
  )
  await submit()
  expect(props.onSchedule).not.toHaveBeenCalled()
  expect(props.onExport).not.toHaveBeenCalled()
  expect(button('Copy Prompt')).toBeUndefined()
  expect(button('Validate and preview').disabled).toBe(true)
  expect(host.querySelector<HTMLTextAreaElement>('#plan-response')?.value).toBe(wizardSaved.text)
})

it('reopens the same draft without leaving an old export active or losing the response', async () => {
  await render()
  expect(button('Copy Prompt')).toBeDefined()
  await click(button('Back to step 1'))
  await click(button('Reopen saved draft'))
  expect(window.localStorage.getItem(wizardStorageKey(wizardOwner))).toContain(wizardSetup.draftId)
  await submit()
  expect(button('Copy Prompt')).toBeUndefined()
  expect(host.querySelector<HTMLTextAreaElement>('#plan-response')?.value).toBe(wizardSaved.text)
  expect(button('Validate and preview').disabled).toBe(true)
})

it('bounds uploads, reads files without approving, and invalidates earlier review', async () => {
  await render()
  const fileInput = host.querySelector<HTMLInputElement>('#plan-response-file')!
  const oversized = new File(['x'.repeat(131073)], 'too-large.json', { type: 'application/json' })
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [oversized] })
  await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })))
  expect(host.textContent).toContain('no larger than 128 KB')
  expect(props.onApprove).not.toHaveBeenCalled()
  const file = new File(['{broken response'], 'response.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: async () => '{broken response' })
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
  await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })))
  expect(host.querySelector<HTMLTextAreaElement>('#plan-response')?.value).toBe('{broken response')
  expect(props.onPreview).not.toHaveBeenCalled()
  expect(props.onApprove).not.toHaveBeenCalled()
})

it('keeps navigation and import disabled while issuing the request', async () => {
  let finish: (value: Awaited<ReturnType<PlanWizardProps['onExport']>>) => void = () => {}
  props.onExport = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await render()
  await submit()
  expect(button('Back to step 1').disabled).toBe(true)
  expect(button('Validate and preview').disabled).toBe(true)
  expect(host.querySelector('[aria-disabled="true"]')?.textContent).toBe(
    'Save and exit to Training',
  )
  await act(async () => finish({ success: true, value: wizardArtifact }))
  expect(button('Back to step 1').disabled).toBe(false)
})
