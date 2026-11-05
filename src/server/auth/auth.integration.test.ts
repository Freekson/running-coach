import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import { createInvitation, listInvitations, revokeInvitation } from './invitation-management'
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
    const ids = [authUserId, secondAuthUserId, retryAuthUserId, replacementAuthUserId].filter(
      Boolean,
    )
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
    expect(data.user.emailVerified).toBe(false)
    cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    expect(cookie).toContain('session_token=')
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
      expect((await signup(retryToken, email)).status).toBe(422)
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
