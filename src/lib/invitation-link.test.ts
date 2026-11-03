import { describe, expect, it } from 'vitest'
import { retainInvitationToken } from './invitation-link'

describe('invitation link fragment', () => {
  it('retains the token when the effect runs again after URL cleanup', () => {
    const first = retainInvitationToken('#token=secret', '')
    expect(retainInvitationToken('', first)).toBe('secret')
  })
})
