import 'server-only'

import { AsyncLocalStorage } from 'node:async_hooks'

const signupClaim = new AsyncLocalStorage<string>()

export function withInvitationClaim<T>(nonce: string, callback: () => Promise<T>): Promise<T> {
  return signupClaim.run(nonce, callback)
}

export function currentInvitationClaimNonce(): string | undefined {
  return signupClaim.getStore()
}
