import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from '@prisma/client'
import { neonConfig } from '@neondatabase/serverless'
import WebSocket from 'ws'
import { assertDatabaseTier, getExpectedDatabaseTier } from './environment'

neonConfig.webSocketConstructor = WebSocket

const globalForPrisma = globalThis as typeof globalThis & { prisma?: PrismaClient }

export async function getPrismaClient(): Promise<PrismaClient> {
  const expectedTier = getExpectedDatabaseTier(process.env)

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for database access')
  }

  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient({
      adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL }),
    })
  }

  const prisma = globalForPrisma.prisma
  try {
    const identity = await prisma.databaseIdentity.findUnique({
      where: { id: 1 },
      select: { tier: true },
    })
    assertDatabaseTier(expectedTier, identity?.tier ?? null)
  } catch {
    // Never return database details or driver errors to callers.
    throw new Error('Database environment verification failed')
  }

  return prisma
}
