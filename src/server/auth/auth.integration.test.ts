import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

vi.mock('server-only', () => ({}))
const requestHeaders = vi.hoisted(() => ({ cookie: '' }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ Cookie: requestHeaders.cookie }),
}))

const databaseTestRequested = process.env.npm_lifecycle_event === 'test:db'
if (databaseTestRequested) config()

const runDatabaseTest =
  databaseTestRequested &&
  (process.env.APP_DATABASE_ENV === 'development' || process.env.APP_DATABASE_ENV === 'test') &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DIRECT_URL) &&
  Boolean(process.env.BETTER_AUTH_SECRET) &&
  !process.env.VERCEL_ENV

if (databaseTestRequested && !runDatabaseTest)
  throw new Error('test:db needs isolated development/test database and Better Auth settings')

import { getPrismaClient } from '@/server/db/client'
import { getAuth } from './better-auth'
import {
  consumeInvitation,
  invitationStatus,
  recoverInvitationAfterFailedSignup,
} from './invitations'
import {
  allowInvitationStatusCheck,
  pruneInvitationStatusRateLimits,
} from './invitation-status-rate-limit'
import {
  checkInvitationStatus,
  createInvitation,
  listInvitations,
  revokeInvitation,
} from './invitation-management'
import { POST } from '@/app/api/auth/[...all]/route'
import { GET as getMe } from '@/app/api/me/route'

describe.skipIf(!runDatabaseTest)('Better Auth on development PostgreSQL', () => {
  let prisma: PrismaClient
  const email = `run17-${randomUUID()}@example.test`
  const password = `Test-${randomUUID()}-passphrase`
  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  let cookie = ''
  let authUserId = ''
  let secondAuthUserId = ''
  let retryAuthUserId = ''
  let partialAuthUserId = ''
  let crossInviteAuthUserId = ''
  let replacementAuthUserId = ''
  let ipCounter = 20

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL = 'http://localhost:3000'
    prisma = await getPrismaClient()
    await prisma.authInvitation.create({
      data: { tokenHash, expiresAt: new Date(Date.now() + 60_000) },
    })
  }, 30_000)

  afterAll(async () => {
    if (!prisma) return
    const ids = [
      authUserId,
      secondAuthUserId,
      retryAuthUserId,
      partialAuthUserId,
      crossInviteAuthUserId,
      replacementAuthUserId,
    ].filter(Boolean)
    await prisma.user.deleteMany({ where: { authSubject: { in: ids } } })
    await prisma.authUser.deleteMany({ where: { id: { in: ids } } })
    await prisma.authInvitation.deleteMany({ where: { tokenHash } })
    await prisma.$disconnect()
  }, 30_000)

  function signup(inviteToken: string, address = email, enteredPassword = password) {
    return POST(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
          'x-forwarded-for': `10.0.0.${ipCounter++}`,
        },
        body: JSON.stringify({
          name: 'Integration Athlete',
          email: address,
          password: enteredPassword,
          invitationToken: inviteToken,
          role: 'ADMIN', // Untrusted input must never create an ADMIN.
        }),
      }),
    )
  }

  it('rejects missing and invalid tokens, then accepts one valid signup', async () => {
    expect((await signup('')).status).toBe(403)
    expect((await signup('f'.repeat(64))).status).toBe(403)
    expect((await signup(token, email, 'short')).status).toBe(400)
    expect(
      (await prisma.authInvitation.findUnique({ where: { tokenHash } }))?.consumedAt,
    ).toBeNull()
    const response = await signup(token)
    expect(response.status).toBe(200)
    const data = await response.json()
    authUserId = data.user.id
    expect(data.user).not.toHaveProperty('invitationClaimNonce')
    expect(
      (await prisma.authUser.findUnique({ where: { id: authUserId } }))?.invitationClaimNonce,
    ).toMatch(/^[0-9a-f-]{36}$/)
    expect(data.user.emailVerified).toBe(false)
    cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    expect(cookie).toContain('session_token=')
    const session = await (
      await getAuth()
    ).api.getSession({ headers: new Headers({ Cookie: cookie }) })
    expect(session?.user).not.toHaveProperty('invitationClaimNonce')
    const invite = await prisma.authInvitation.findUnique({ where: { tokenHash } })
    expect(invite?.consumedAt).not.toBeNull()
    expect(await prisma.authRateLimit.count()).toBeGreaterThan(0)
    requestHeaders.cookie = ''
    expect((await getMe()).status).toBe(401)
    requestHeaders.cookie = `${cookie.split('=')[0]}=invalid`
    expect((await getMe()).status).toBe(401)
    requestHeaders.cookie = cookie
    const firstRequests = await Promise.all([getMe(), getMe(), getMe()])
    for (const me of firstRequests) {
      expect(me.status).toBe(200)
      expect(await me.json()).toMatchObject({ role: 'USER' })
    }
    expect(await prisma.user.count({ where: { authSubject: authUserId } })).toBe(1)
  }, 30_000)

  it('releases a token after Better Auth rejects an already registered email', async () => {
    const retryToken = randomBytes(32).toString('hex')
    const retryHash = createHash('sha256').update(retryToken).digest('hex')
    await prisma.authInvitation.create({
      data: { tokenHash: retryHash, expiresAt: new Date(Date.now() + 60_000) },
    })
    try {
      const duplicate = await signup(retryToken, email)
      expect(duplicate.status).toBe(422)
      expect(duplicate.headers.get('x-running-coach-error')).toBe('duplicate-email')
      expect(
        (await prisma.authInvitation.findUnique({ where: { tokenHash: retryHash } }))?.consumedAt,
      ).toBeNull()
      const accepted = await signup(retryToken, `retry-${email}`)
      expect(accepted.status).toBe(200)
      retryAuthUserId = (await accepted.json()).user.id
    } finally {
      await prisma.authInvitation.deleteMany({ where: { tokenHash: retryHash } })
    }
  }, 30_000)

  it('recovers a failed claim only when no account exists', async () => {
    const recoveryToken = randomBytes(32).toString('hex')
    const recoveryHash = createHash('sha256').update(recoveryToken).digest('hex')
    await prisma.authInvitation.create({
      data: { tokenHash: recoveryHash, expiresAt: new Date(Date.now() + 60_000) },
    })
    try {
      const firstClaim = await consumeInvitation(recoveryToken, `missing-${email}`)
      if (!firstClaim) throw new Error('Expected a valid invitation claim')
      expect(await recoverInvitationAfterFailedSignup(firstClaim)).toBe(true)
      expect(
        (await prisma.authInvitation.findUnique({ where: { tokenHash: recoveryHash } }))
          ?.consumedAt,
      ).toBeNull()
      const secondClaim = await consumeInvitation(recoveryToken, email)
      if (!secondClaim) throw new Error('Expected a second invitation claim')
      expect(await recoverInvitationAfterFailedSignup(secondClaim)).toBe(true)
      expect(
        (await prisma.authInvitation.findUnique({ where: { tokenHash: recoveryHash } }))
          ?.consumedAt,
      ).toBeNull()
    } finally {
      await prisma.authInvitation.deleteMany({ where: { tokenHash: recoveryHash } })
    }
  }, 30_000)

  it('removes a partial Better Auth user and makes its invitation reusable', async () => {
    const recoveryToken = randomBytes(32).toString('hex')
    const recoveryHash = createHash('sha256').update(recoveryToken).digest('hex')
    const recoveryEmail = `partial-${email}`
    await prisma.authInvitation.create({
      data: { tokenHash: recoveryHash, expiresAt: new Date(Date.now() + 60_000) },
    })
    try {
      const claim = await consumeInvitation(recoveryToken, recoveryEmail)
      if (!claim) throw new Error('Expected an invitation claim')
      await prisma.authUser.create({
        data: {
          id: randomUUID(),
          name: 'Partial Athlete',
          email: recoveryEmail,
          invitationClaimNonce: claim.nonce,
        },
      })
      expect(await recoverInvitationAfterFailedSignup(claim)).toBe(true)
      expect(await prisma.authUser.findUnique({ where: { email: recoveryEmail } })).toBeNull()
      expect(await invitationStatus(recoveryToken)).toBe('valid')
      const response = await signup(recoveryToken, recoveryEmail)
      expect(response.status).toBe(200)
      partialAuthUserId = (await response.json()).user.id
    } finally {
      await prisma.authUser.deleteMany({ where: { email: recoveryEmail } })
      await prisma.authInvitation.deleteMany({ where: { tokenHash: recoveryHash } })
    }
  }, 30_000)

  it('does not consume an abandoned invite when another invite created the email', async () => {
    const firstToken = randomBytes(32).toString('hex')
    const secondToken = randomBytes(32).toString('hex')
    const firstHash = createHash('sha256').update(firstToken).digest('hex')
    const secondHash = createHash('sha256').update(secondToken).digest('hex')
    const sharedEmail = `cross-invite-${email}`
    await prisma.authInvitation.createMany({
      data: [
        { tokenHash: firstHash, expiresAt: new Date(Date.now() + 60_000) },
        { tokenHash: secondHash, expiresAt: new Date(Date.now() + 60_000) },
      ],
    })
    try {
      const firstClaim = await consumeInvitation(firstToken, sharedEmail)
      if (!firstClaim) throw new Error('Expected first invitation claim')
      const secondResponse = await signup(secondToken, sharedEmail)
      expect(secondResponse.status).toBe(200)
      crossInviteAuthUserId = (await secondResponse.json()).user.id
      const createdUser = await prisma.authUser.findUnique({ where: { id: crossInviteAuthUserId } })
      expect(createdUser?.invitationClaimNonce).not.toBe(firstClaim.nonce)
      await prisma.authInvitation.update({
        where: { tokenHash: firstHash },
        data: { claimedAt: new Date(Date.now() - 3 * 60_000) },
      })
      expect(await invitationStatus(firstToken)).toBe('valid')
      expect(await invitationStatus(secondToken)).toBe('used')
      expect(
        await prisma.authUser.findUnique({ where: { id: crossInviteAuthUserId } }),
      ).not.toBeNull()
    } finally {
      await prisma.authUser.deleteMany({ where: { email: sharedEmail } })
      await prisma.authInvitation.deleteMany({
        where: { tokenHash: { in: [firstHash, secondHash] } },
      })
    }
  }, 30_000)

  it('lets an admin revoke an abandoned claim by invitation ID', async () => {
    const abandonedToken = randomBytes(32).toString('hex')
    const abandonedHash = createHash('sha256').update(abandonedToken).digest('hex')
    const invitation = await prisma.authInvitation.create({
      data: { tokenHash: abandonedHash, expiresAt: new Date(Date.now() + 60_000) },
    })
    try {
      expect(await consumeInvitation(abandonedToken, `revoke-${email}`)).not.toBeNull()
      await prisma.authInvitation.update({
        where: { id: invitation.id },
        data: { claimedAt: new Date(Date.now() - 3 * 60_000) },
      })
      expect(await revokeInvitation(invitation.id)).toBe(true)
      expect(await invitationStatus(abandonedToken)).toBe('revoked')
    } finally {
      await prisma.authInvitation.deleteMany({ where: { id: invitation.id } })
    }
  }, 30_000)

  it('reconciles an abandoned claim on a later invitation check', async () => {
    const abandonedToken = randomBytes(32).toString('hex')
    const abandonedHash = createHash('sha256').update(abandonedToken).digest('hex')
    await prisma.authInvitation.create({
      data: { tokenHash: abandonedHash, expiresAt: new Date(Date.now() + 60_000) },
    })
    try {
      const claim = await consumeInvitation(abandonedToken, `abandoned-${email}`)
      if (!claim) throw new Error('Expected an invitation claim')
      const claimedInvitation = await prisma.authInvitation.findUnique({
        where: { tokenHash: abandonedHash },
        select: { id: true },
      })
      if (!claimedInvitation) throw new Error('Expected a stored invitation')
      expect(await revokeInvitation(claimedInvitation.id)).toBe(false)
      expect(await invitationStatus(abandonedToken)).toBe('processing')
      await prisma.authInvitation.update({
        where: { tokenHash: abandonedHash },
        data: { claimedAt: new Date(Date.now() - 3 * 60_000) },
      })
      expect(
        (await listInvitations()).find((item) => item.id === claimedInvitation.id)?.status,
      ).toBe('processing')
      expect(await checkInvitationStatus(claimedInvitation.id)).toBe('pending')
      expect(await invitationStatus(abandonedToken)).toBe('valid')
      expect(
        (await prisma.authInvitation.findUnique({ where: { tokenHash: abandonedHash } }))
          ?.claimedAt,
      ).toBeNull()
      expect(await consumeInvitation(abandonedToken, `recovered-${email}`)).not.toBeNull()
    } finally {
      await prisma.authInvitation.deleteMany({ where: { tokenHash: abandonedHash } })
    }
  }, 30_000)

  it('shares an atomic per-client invitation-status limit across requests', async () => {
    const clientIp = '192.0.2.245'
    const otherIp = '192.0.2.246'
    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) throw new Error('Expected Better Auth secret')
    const rateKey = `running-coach:invitation-status:ip:${createHmac('sha256', secret).update(clientIp).digest('hex')}`
    const otherKey = `running-coach:invitation-status:ip:${createHmac('sha256', secret).update(otherIp).digest('hex')}`
    const now = Date.now()
    try {
      expect(await allowInvitationStatusCheck(clientIp, now)).toBe(true)
      await prisma.authRateLimit.update({
        where: { key: rateKey },
        data: { count: 60 },
      })
      expect(await allowInvitationStatusCheck(clientIp, now + 1)).toBe(false)
      expect(await allowInvitationStatusCheck(otherIp, now + 1)).toBe(true)
      expect(await allowInvitationStatusCheck(clientIp, now + 60_001)).toBe(true)
    } finally {
      await prisma.authRateLimit.deleteMany({ where: { key: { in: [rateKey, otherKey] } } })
    }
  }, 30_000)

  it('prunes only expired invitation-status rate-limit keys', async () => {
    const oldKey = `running-coach:invitation-status:ip:${randomUUID()}`
    const recentKey = `running-coach:invitation-status:ip:${randomUUID()}`
    const otherKey = `better-auth:${randomUUID()}`
    const now = Date.now()
    await prisma.authRateLimit.createMany({
      data: [
        { id: oldKey, key: oldKey, count: 1, lastRequest: BigInt(now - 2 * 24 * 60 * 60_000) },
        { id: recentKey, key: recentKey, count: 1, lastRequest: BigInt(now) },
        { id: otherKey, key: otherKey, count: 1, lastRequest: BigInt(now - 2 * 24 * 60 * 60_000) },
      ],
    })
    try {
      expect(await pruneInvitationStatusRateLimits(now)).toBeGreaterThanOrEqual(1)
      expect(await prisma.authRateLimit.findUnique({ where: { key: oldKey } })).toBeNull()
      expect(await prisma.authRateLimit.findUnique({ where: { key: recentKey } })).not.toBeNull()
      expect(await prisma.authRateLimit.findUnique({ where: { key: otherKey } })).not.toBeNull()
    } finally {
      await prisma.authRateLimit.deleteMany({
        where: { key: { in: [oldKey, recentKey, otherKey] } },
      })
    }
  }, 30_000)

  it('allows exactly one concurrent redemption of a new link', async () => {
    const raceToken = randomBytes(32).toString('hex')
    const raceHash = createHash('sha256').update(raceToken).digest('hex')
    await prisma.authInvitation.create({
      data: { tokenHash: raceHash, expiresAt: new Date(Date.now() + 60_000) },
    })
    try {
      const raceEmail = `race-${email}`
      const alternateEmail = `race-alt-${email}`
      const [first, second] = await Promise.all([
        signup(raceToken, raceEmail),
        signup(raceToken, alternateEmail),
      ])
      expect([first.status, second.status].sort()).toEqual([200, 403])
      const accepted = first.status === 200 ? first : second
      secondAuthUserId = (await accepted.json()).user.id
      expect(
        await prisma.authUser.count({ where: { email: { in: [raceEmail, alternateEmail] } } }),
      ).toBe(1)
    } finally {
      await prisma.authInvitation.deleteMany({ where: { tokenHash: raceHash } })
    }
  }, 30_000)

  it('creates a hashed invite, revokes it, and registers with a new replacement link', async () => {
    const first = await createInvitation('Integration friend')
    const firstToken = new URL(first.url).hash.slice('#token='.length)
    const replacement = await createInvitation('Replacement')
    const replacementToken = new URL(replacement.url).hash.slice('#token='.length)
    try {
      const stored = await prisma.authInvitation.findUnique({ where: { id: first.id } })
      expect(stored).not.toBeNull()
      if (!stored) throw new Error('Expected a stored invitation')
      expect(stored.tokenHash).toBe(createHash('sha256').update(firstToken).digest('hex'))
      expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
      expect((await listInvitations()).find((invite) => invite.id === first.id)).toMatchObject({
        label: 'Integration friend',
        status: 'pending',
      })
      expect(await revokeInvitation(first.id)).toBe(true)
      expect(await revokeInvitation(first.id)).toBe(false)
      expect((await signup(firstToken, `revoked-${email}`)).status).toBe(403)
      const accepted = await signup(replacementToken, `replacement-${email}`)
      expect(accepted.status).toBe(200)
      replacementAuthUserId = (await accepted.json()).user.id
      expect((await signup(replacementToken, `replay-replacement-${email}`)).status).toBe(403)
    } finally {
      await prisma.authInvitation.deleteMany({ where: { id: { in: [first.id, replacement.id] } } })
    }
  }, 30_000)

  it('rejects replay and expired or revoked tokens', async () => {
    expect((await signup(token, `replay-${email}`)).status).toBe(403)
    const expired = randomBytes(32).toString('hex')
    const revoked = randomBytes(32).toString('hex')
    const expiredHash = createHash('sha256').update(expired).digest('hex')
    const revokedHash = createHash('sha256').update(revoked).digest('hex')
    await prisma.authInvitation.createMany({
      data: [
        { tokenHash: expiredHash, expiresAt: new Date(Date.now() - 1_000) },
        { tokenHash: revokedHash, expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() },
      ],
    })
    try {
      expect((await signup(expired, `expired-${email}`)).status).toBe(403)
      expect((await signup(revoked, `revoked-${email}`)).status).toBe(403)
    } finally {
      await prisma.authInvitation.deleteMany({
        where: { tokenHash: { in: [expiredHash, revokedHash] } },
      })
    }
  }, 30_000)

  it('signs in and rejects an expired session', async () => {
    const auth = await getAuth()
    const logout = await auth.handler(
      new Request('http://localhost:3000/api/auth/sign-out', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    )
    expect(logout.status).toBe(200)
    expect(await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) })).toBeNull()
    const login = await auth.handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
    )
    expect(login.status).toBe(200)
    const loginCookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    const valid = await auth.api.getSession({ headers: new Headers({ Cookie: loginCookie }) })
    expect(valid?.user.id).toBe(authUserId)
    await prisma.authSession.updateMany({
      where: { userId: authUserId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })
    const expired = await auth.api.getSession({ headers: new Headers({ Cookie: loginCookie }) })
    expect(expired).toBeNull()
    requestHeaders.cookie = loginCookie
    expect((await getMe()).status).toBe(401)
  }, 30_000)

  it('enforces the shared database login limit for concurrent attempts', async () => {
    const auth = await getAuth()
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        auth.handler(
          new Request('http://localhost:3000/api/auth/sign-in/email', {
            method: 'POST',
            headers: {
              Origin: 'http://localhost:3000',
              'Content-Type': 'application/json',
              'x-forwarded-for': '192.0.2.91',
            },
            body: JSON.stringify({ email: `missing-${email}`, password }),
          }),
        ),
      ),
    )
    expect(attempts.filter((response) => response.status === 429)).toHaveLength(1)
    expect(await prisma.authRateLimit.count()).toBeGreaterThan(0)
  }, 30_000)
})
