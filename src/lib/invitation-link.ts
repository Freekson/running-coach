const tokenPattern = /^[a-f0-9]{64}$/

// A new link takes precedence; a tab-scoped copy survives a remount after the
// fragment is removed from the address bar.
export function retainInvitationToken(hash: string, previous: string, stored = ''): string {
  const fromHash = new URLSearchParams(hash.slice(1)).get('token')
  if (fromHash !== null) return tokenPattern.test(fromHash) ? fromHash : ''
  if (tokenPattern.test(previous)) return previous
  return tokenPattern.test(stored) ? stored : ''
}
