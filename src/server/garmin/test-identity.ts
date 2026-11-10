import type { OwnerContext } from '@/server/authorization/ownership'

/** A synthetic stable profile ID derived from each test owner's random UUID. */
export function testGarminAccountId(owner: OwnerContext): string {
  return String(BigInt(`0x${owner.userId.replaceAll('-', '').slice(-12)}`) + BigInt(1))
}
