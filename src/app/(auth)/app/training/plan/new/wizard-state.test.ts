import { expect, it } from 'vitest'
import { readWizard, wizardStorageKey, emptyWizard } from './wizard-state'
import { wizardSaved, wizardOwner } from './plan-wizard.fixtures'

it('restores recoverable inputs without trusting stored approval or validation', () => {
  const saved = { ...wizardSaved, step: 3, approved: true, validation: { valid: true } }
  const result = readWizard({ getItem: () => JSON.stringify(saved) }, 'draft')
  expect(result).toEqual({ ...wizardSaved, step: 3 })
  expect(result).not.toHaveProperty('approved')
  expect(result).not.toHaveProperty('validation')
})
it('isolates storage keys by account and handles corrupt or unavailable storage', () => {
  expect(wizardStorageKey(wizardOwner)).not.toBe(wizardStorageKey('another-user'))
  for (const text of [
    '{broken',
    '{}',
    JSON.stringify({
      ...wizardSaved,
      exportState: {
        ...wizardSaved.exportState,
        result: { ...wizardSaved.exportState?.result, json: '{}' },
      },
    }),
  ])
    expect(readWizard({ getItem: () => text }, 'draft')).toEqual(emptyWizard)
  expect(
    readWizard(
      {
        getItem: () => {
          throw new Error('Blocked')
        },
      },
      'draft',
    ),
  ).toEqual(emptyWizard)
})
it('keeps invalid schedule edits and malformed response text so validation failures are recoverable', () => {
  const state = {
    ...wizardSaved,
    text: '{broken response',
    exportState: {
      ...wizardSaved.exportState,
      constraints: { ...wizardSaved.setup!.constraints, sessionsPerWeek: 7, availableWeekdays: [] },
    },
  }
  const restored = readWizard({ getItem: () => JSON.stringify(state) }, 'draft')
  expect(restored.text).toBe('{broken response')
  expect(restored.exportState?.constraints?.availableWeekdays).toEqual([])
})
