import 'server-only'

import { prismaAdapter } from 'better-auth/adapters/prisma'
import { betterAuth } from 'better-auth'
import type { PrismaClient } from '@prisma/client'
import { getPrismaClient } from '@/server/db/client'
import { currentInvitationClaimNonce } from './invitation-claim-context'

export function getTrustedOrigins(baseURL: string): string[] {
  const origins = [new URL(baseURL).origin]
  if (process.env.VERCEL_URL) origins.push(new URL(`https://${process.env.VERCEL_URL}`).origin)
  if (process.env.VERCEL_BRANCH_URL)
    origins.push(new URL(`https://${process.env.VERCEL_BRANCH_URL}`).origin)
  return [...new Set(origins)]
}

function createAuth(prisma: PrismaClient, secret: string, baseURL: string) {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: 'postgresql', transaction: true }),
    secret,
    baseURL,
    trustedOrigins: getTrustedOrigins(baseURL),
    rateLimit: { enabled: true, storage: 'database', modelName: 'authRateLimit' },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    user: {
      modelName: 'authUser',
      additionalFields: {
        invitationClaimNonce: { type: 'string', required: false, input: false, returned: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(user, context) {
            const nonce = currentInvitationClaimNonce()
            if (nonce) return { data: { ...user, invitationClaimNonce: nonce } }
            if (context?.path === '/sign-up/email') return false
          },
        },
      },
    },
    session: { modelName: 'authSession' },
    account: { modelName: 'authAccount' },
    verification: { modelName: 'authVerification' },
  })
}

type Auth = ReturnType<typeof createAuth>
let authPromise: Promise<Auth> | undefined

export function getAuth(): Promise<Auth> {
  authPromise ??= (async () => {
    const secret = process.env.BETTER_AUTH_SECRET
    const baseURL = process.env.BETTER_AUTH_URL
    if (!secret || secret.length < 32 || !baseURL)
      throw new Error('Better Auth environment is incomplete')
    const prisma = await getPrismaClient()
    return createAuth(prisma, secret, baseURL)
  })().catch((error: unknown) => {
    authPromise = undefined
    throw error
  })
  return authPromise
}
