import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'

export function createInvitationMaterial(baseURL) {
  const url = new URL(baseURL)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && url.hostname !== 'localhost')
  ) {
    throw new Error('A secure BETTER_AUTH_URL is required')
  }
  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const link = new URL('/sign-up', url)
  link.hash = `token=${token}`
  return { tokenHash, link: link.toString() }
}

export async function bootstrapAdmin(prisma, authUserId) {
  return prisma.$transaction(
    async (tx) => {
      const admins = await tx.user.count({ where: { role: 'ADMIN' } })
      if (admins !== 0) throw new Error('An ADMIN already exists')
      const authUser = await tx.authUser.findUnique({ where: { id: authUserId } })
      if (!authUser) throw new Error('Unknown Better Auth user ID')
      const localUser = await tx.user.findUnique({ where: { authSubject: authUserId } })
      if (!localUser || localUser.status !== 'ACTIVE')
        throw new Error('Account must sign in and be active before bootstrap')
      await tx.user.update({ where: { id: localUser.id }, data: { role: 'ADMIN' } })
    },
    { isolationLevel: 'Serializable' },
  )
}

async function main() {
  const [action, value, confirmation] = process.argv.slice(2)
  const tier = process.env.APP_DATABASE_ENV
  if (
    !['development', 'production'].includes(tier) ||
    !process.env.DIRECT_URL ||
    !process.env.BETTER_AUTH_URL
  )
    throw new Error('Operator environment is incomplete')
  if (tier === 'production' && ![value, confirmation].includes('--production'))
    throw new Error('Production requires the --production argument')
  const direct = new URL(process.env.DIRECT_URL)
  if (direct.hostname.includes('-pooler.')) throw new Error('DIRECT_URL must use a direct host')
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } })
  try {
    const identity = await prisma.databaseIdentity.findUnique({ where: { id: 1 } })
    const expected = tier === 'production' ? 'PRODUCTION' : 'NON_PRODUCTION'
    if (identity?.tier !== expected)
      throw new Error('Database identity does not match operator environment')
    if (action === 'invite') {
      if (value && value !== '--production') throw new Error('Unexpected invite argument')
      const { tokenHash, link } = createInvitationMaterial(process.env.BETTER_AUTH_URL)
      await prisma.authInvitation.create({
        data: { tokenHash, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      })
      process.stdout.write(`${link}\n`)
    } else if (action === 'bootstrap-admin') {
      if (!value) throw new Error('Provide a verified Better Auth user ID')
      await bootstrapAdmin(prisma, value)
      process.stdout.write('Initial ADMIN provisioned.\n')
    } else {
      throw new Error('Use invite or bootstrap-admin')
    }
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(
      'Auth operator action failed. Check the arguments and selected database.\n',
    )
    process.exitCode = 1
  })
}
