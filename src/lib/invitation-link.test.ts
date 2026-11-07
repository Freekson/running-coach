import { describe, expect, it } from 'vitest'
import { retainInvitationToken } from './invitation-link'

describe('invitation link fragment', () => {
  const firstToken = 'a'.repeat(64)
  const secondToken = 'b'.repeat(64)

  it('retains the token after URL cleanup and a component remount', () => {
    const first = retainInvitationToken(`#token=${firstToken}`, '')
    expect(retainInvitationToken('', first)).toBe(firstToken)
    expect(retainInvitationToken('', '', first)).toBe(firstToken)
  })

  it('prefers a newly opened link over a token stored in the tab', () => {
    expect(retainInvitationToken(`#token=${secondToken}`, firstToken, firstToken)).toBe(secondToken)
  })

  it('rejects missing and malformed tokens before signup', () => {
    expect(retainInvitationToken('', '', '')).toBe('')
    expect(retainInvitationToken('#token=invalid', '', firstToken)).toBe('')
  })
})
