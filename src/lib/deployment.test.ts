import { describe, expect, it } from 'vitest'
import { getDeploymentKind } from './deployment'

describe('getDeploymentKind', () => {
  it.each([
    ['preview', 'preview'],
    ['production', 'production'],
    [undefined, 'local'],
    ['untrusted private value', 'local'],
  ] as const)('maps %s to a safe public label', (input, expected) => {
    expect(getDeploymentKind(input)).toBe(expected)
  })
})
