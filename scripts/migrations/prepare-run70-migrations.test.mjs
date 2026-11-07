import { describe, expect, it, vi } from 'vitest'
import { prepareRun70Migrations } from './prepare-run70-migrations.mjs'

const first = '20261106_run70_recoverable_invitation_claim'
const second = '20261106_run70_claim_identity_and_rate_expiry'
const expectedColumns = new Map([
  [
    'auth_invitations.claimed_at',
    { type: 'timestamptz', length: null, precision: 6, nullable: 'YES' },
  ],
  ['auth_invitations.claimed_email', { type: 'varchar', length: 320, nullable: 'YES' }],
  ['auth_users.invitation_claim_nonce', { type: 'uuid', length: null, nullable: 'YES' }],
  ['auth_invitations.claimed_nonce', { type: 'uuid', length: null, nullable: 'YES' }],
])
const expectedIndexes = new Map([
  [
    'auth_users_invitation_claim_nonce_key',
    { table: 'auth_users', column: 'invitation_claim_nonce', unique: true },
  ],
  [
    'auth_invitations_claimed_nonce_key',
    { table: 'auth_invitations', column: 'claimed_nonce', unique: true },
  ],
  [
    'auth_rate_limits_lastRequest_idx',
    { table: 'auth_rate_limits', column: 'lastRequest', unique: false },
  ],
])

function database({ fresh = false, applied = [], indexes = new Map(), missingColumns = [] } = {}) {
  const migrated = new Set(applied)
  const columns = new Map(expectedColumns)
  for (const column of missingColumns) columns.delete(column)
  const catalog = new Map(indexes)
  const statements = []
  const prisma = {
    $queryRaw: vi.fn(async (parts, ...values) => {
      const sql = parts.join('?')
      if (sql.includes('to_regclass')) {
        return [
          {
            users: !fresh,
            invitations: !fresh,
            rateLimits: !fresh,
            ledger: !fresh,
          },
        ]
      }
      if (sql.includes('FROM "_prisma_migrations"')) {
        return migrated.has(values[0]) ? [{ finishedAt: new Date(), rolledBackAt: null }] : []
      }
      if (sql.includes('information_schema.columns')) {
        const column = columns.get(`${values[0]}.${values[1]}`)
        return column ? [column] : []
      }
      if (sql.includes('FROM pg_class index_class')) {
        const index = catalog.get(values[0])
        return index ? [index] : []
      }
      throw new Error(`Unexpected query: ${sql}`)
    }),
    $executeRawUnsafe: vi.fn(async (sql) => {
      statements.push(sql)
      if (sql.startsWith('ALTER TABLE')) {
        const match = sql.match(/ALTER TABLE "([^"]+)" ADD COLUMN IF NOT EXISTS "([^"]+)"/)
        const key = `${match?.[1]}.${match?.[2]}`
        columns.set(key, expectedColumns.get(key))
      }
      if (sql.startsWith('CREATE')) {
        const name = sql.match(/INDEX CONCURRENTLY "([^"]+)"/)?.[1]
        const spec = expectedIndexes.get(name)
        catalog.set(name, {
          ...spec,
          valid: true,
          ready: true,
          keyCount: 1,
          noPredicate: true,
          noExpression: true,
          nullsNotDistinct: false,
          method: 'btree',
        })
      }
    }),
    $transaction: vi.fn(async (callback) => callback(prisma)),
  }
  const resolve = vi.fn(async (name) => {
    statements.push(`resolve ${name}`)
    migrated.add(name)
  })
  return { prisma, resolve, statements, catalog }
}

describe('RUN-70 concurrent migration preparation', () => {
  it('leaves an empty database to the original migrations', async () => {
    const { prisma, resolve, statements } = database({ fresh: true })
    expect(await prepareRun70Migrations(prisma, resolve)).toBe('fresh')
    expect(statements).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('creates and verifies all indexes before resolving the pending migration', async () => {
    const { prisma, resolve, statements } = database({ applied: [first] })
    expect(await prepareRun70Migrations(prisma, resolve)).toBe('prepared')
    expect(statements.filter((sql) => sql.startsWith('CREATE'))).toHaveLength(3)
    expect(statements.at(-1)).toBe(`resolve ${second}`)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('adds missing nullable columns under a lock timeout before resolving each migration', async () => {
    const { prisma, resolve, statements } = database({
      missingColumns: ['auth_invitations.claimed_at', 'auth_users.invitation_claim_nonce'],
    })
    expect(await prepareRun70Migrations(prisma, resolve)).toBe('prepared')
    expect(statements.filter((sql) => sql.startsWith('SET LOCAL lock_timeout'))).toHaveLength(2)
    expect(statements.indexOf(`resolve ${first}`)).toBeLessThan(
      statements.indexOf(
        'CREATE UNIQUE INDEX CONCURRENTLY "auth_users_invitation_claim_nonce_key" ON "auth_users"("invitation_claim_nonce")',
      ),
    )
    expect(statements.at(-1)).toBe(`resolve ${second}`)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('refuses to resolve a migration with a wrong existing index', async () => {
    const indexes = new Map([
      [
        'auth_users_invitation_claim_nonce_key',
        {
          table: 'auth_users',
          column: 'wrong_column',
          unique: true,
          valid: true,
          ready: true,
          keyCount: 1,
          noPredicate: true,
          noExpression: true,
          nullsNotDistinct: false,
          method: 'btree',
        },
      ],
    ])
    const { prisma, resolve } = database({ applied: [first], indexes })
    await expect(prepareRun70Migrations(prisma, resolve)).rejects.toThrow(
      'did not match its migration',
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does nothing when both migrations are already applied', async () => {
    const { prisma, resolve, statements } = database({ applied: [first, second] })
    expect(await prepareRun70Migrations(prisma, resolve)).toBe('already-applied')
    expect(statements).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects a unique index that treats NULL values as equal', async () => {
    const indexes = new Map([
      [
        'auth_invitations_claimed_nonce_key',
        {
          table: 'auth_invitations',
          column: 'claimed_nonce',
          unique: true,
          valid: true,
          ready: true,
          keyCount: 1,
          noPredicate: true,
          noExpression: true,
          nullsNotDistinct: true,
          method: 'btree',
        },
      ],
    ])
    const { prisma, resolve } = database({ applied: [first], indexes })
    await expect(prepareRun70Migrations(prisma, resolve)).rejects.toThrow(
      'did not match its migration',
    )
    expect(resolve).not.toHaveBeenCalled()
  })
})
