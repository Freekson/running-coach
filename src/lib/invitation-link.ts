// The fragment is removed from the address bar after first read. React may
// re-run effects in development, so an empty second read must keep the token.
export function retainInvitationToken(hash: string, previous: string): string {
  return new URLSearchParams(hash.slice(1)).get('token') || previous
}
