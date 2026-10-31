import { afterEach, describe, expect, it, vi } from 'vitest'

const endpoint = 'ep-example.us-east-1.aws.neon.tech'
const direct = `postgresql://migrator:synthetic@${endpoint}/coach_dev`
const pooled = 'postgresql://app:synthetic@ep-example-pooler.us-east-1.aws.neon.tech/coach_dev'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Prisma CLI direct URL target', () => {
  it('rejects different PostgreSQL schemas on the same Neon database', async () => {
    vi.stubEnv('DATABASE_URL', `${pooled}?schema=public`)
    vi.stubEnv('DIRECT_URL', `${direct}?schema=other`)
    await expect(import('./prisma.config')).rejects.toThrow('same database and schema')
  })

  it('treats an omitted schema as public', async () => {
    vi.stubEnv('DATABASE_URL', pooled)
    vi.stubEnv('DIRECT_URL', `${direct}?schema=public`)
    await expect(import('./prisma.config')).resolves.toBeDefined()
  })

  it('rejects a shared non-public schema because operator SQL targets public', async () => {
    vi.stubEnv('DATABASE_URL', `${pooled}?schema=other`)
    vi.stubEnv('DIRECT_URL', `${direct}?schema=other`)
    await expect(import('./prisma.config')).rejects.toThrow('same database and schema')
  })
})
