import 'dotenv/config'

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PrismaClient } from '@prisma/client'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const prismaCli = require.resolve('prisma/build/index.js')
const firstMigration = '20261106_run70_recoverable_invitation_claim'
const secondMigration = '20261106_run70_claim_identity_and_rate_expiry'

const columns = {
  first: [
    {
      table: 'auth_invitations',
      name: 'claimed_at',
      type: 'timestamptz',
      sql: 'ALTER TABLE "auth_invitations" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMPTZ(6)',
    },
    {
      table: 'auth_invitations',
      name: 'claimed_email',
      type: 'varchar',
      length: 320,
      sql: 'ALTER TABLE "auth_invitations" ADD COLUMN IF NOT EXISTS "claimed_email" VARCHAR(320)',
    },
  ],
  second: [
    {
      table: 'auth_users',
      name: 'invitation_claim_nonce',
      type: 'uuid',
      sql: 'ALTER TABLE "auth_users" ADD COLUMN IF NOT EXISTS "invitation_claim_nonce" UUID',
    },
    {
      table: 'auth_invitations',
      name: 'claimed_nonce',
      type: 'uuid',
      sql: 'ALTER TABLE "auth_invitations" ADD COLUMN IF NOT EXISTS "claimed_nonce" UUID',
    },
  ],
}

const indexes = [
  {
    name: 'auth_users_invitation_claim_nonce_key',
    table: 'auth_users',
    column: 'invitation_claim_nonce',
    unique: true,
    create:
      'CREATE UNIQUE INDEX CONCURRENTLY "auth_users_invitation_claim_nonce_key" ON "auth_users"("invitation_claim_nonce")',
  },
  {
    name: 'auth_invitations_claimed_nonce_key',
    table: 'auth_invitations',
    column: 'claimed_nonce',
    unique: true,
    create:
      'CREATE UNIQUE INDEX CONCURRENTLY "auth_invitations_claimed_nonce_key" ON "auth_invitations"("claimed_nonce")',
  },
  {
    name: 'auth_rate_limits_lastRequest_idx',
    table: 'auth_rate_limits',
    column: 'lastRequest',
    unique: false,
    create:
      'CREATE INDEX CONCURRENTLY "auth_rate_limits_lastRequest_idx" ON "auth_rate_limits"("lastRequest")',
  },
]

async function migrationApplied(prisma, name) {
  const rows = await prisma.$queryRaw`
    SELECT finished_at AS "finishedAt", rolled_back_at AS "rolledBackAt"
    FROM "_prisma_migrations" WHERE migration_name = ${name}
  `
  if (rows.some((row) => row.finishedAt && !row.rolledBackAt)) return true
  if (rows.length)
    throw new Error(`${name} has an incomplete migration record; inspect it manually`)
  return false
}

async function columnMetadata(prisma, column) {
  const rows = await prisma.$queryRaw`
    SELECT udt_name AS "type", character_maximum_length AS "length",
      datetime_precision AS "precision", is_nullable AS "nullable"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${column.table}
      AND column_name = ${column.name}
  `
  return rows[0]
}

async function ensureColumns(prisma, expected, allowCreate) {
  for (const column of expected) {
    if (!(await columnMetadata(prisma, column))) {
      if (!allowCreate)
        throw new Error(`Applied migration is missing ${column.table}.${column.name}`)
      // Nullable column additions are brief, but stop instead of waiting behind
      // a long transaction and holding up application writes.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
        await tx.$executeRawUnsafe(column.sql)
      })
    }
    const actual = await columnMetadata(prisma, column)
    if (
      actual?.type !== column.type ||
      actual.nullable !== 'YES' ||
      (column.type === 'timestamptz' && actual.precision !== 6) ||
      (column.length !== undefined && actual.length !== column.length)
    ) {
      throw new Error(`Unexpected definition for ${column.table}.${column.name}`)
    }
  }
}

async function indexMetadata(prisma, index) {
  const rows = await prisma.$queryRaw`
    SELECT table_class.relname AS "table", idx.indisvalid AS "valid",
      idx.indisready AS "ready", idx.indisunique AS "unique",
      idx.indnkeyatts AS "keyCount", idx.indpred IS NULL AS "noPredicate",
      idx.indexprs IS NULL AS "noExpression",
      COALESCE((to_jsonb(idx)->>'indnullsnotdistinct')::boolean, false) AS "nullsNotDistinct",
      access_method.amname AS "method",
      pg_get_indexdef(idx.indexrelid, 1, true) AS "column"
    FROM pg_class index_class
    JOIN pg_namespace ns ON ns.oid = index_class.relnamespace
    JOIN pg_index idx ON idx.indexrelid = index_class.oid
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    JOIN pg_class table_class ON table_class.oid = idx.indrelid
    WHERE ns.nspname = 'public' AND index_class.relname = ${index.name}
  `
  return rows[0]
}

async function ensureIndex(prisma, index) {
  let actual = await indexMetadata(prisma, index)
  if (actual && (actual.table !== index.table || actual.unique !== index.unique)) {
    throw new Error(`Unexpected index ${index.name}`)
  }
  if (actual && !actual.valid) {
    // A failed concurrent build leaves an invalid index. Clear only this known
    // index, then retry the build on the next statement.
    await prisma.$executeRawUnsafe(`DROP INDEX CONCURRENTLY "${index.name}"`)
    actual = undefined
  }
  if (!actual) await prisma.$executeRawUnsafe(index.create)
  actual = await indexMetadata(prisma, index)
  if (
    !actual?.valid ||
    !actual.ready ||
    actual.table !== index.table ||
    actual.unique !== index.unique ||
    Number(actual.keyCount) !== 1 ||
    !actual.noPredicate ||
    !actual.noExpression ||
    actual.nullsNotDistinct ||
    actual.method !== 'btree' ||
    actual.column?.replaceAll('"', '') !== index.column
  ) {
    throw new Error(`Concurrent index ${index.name} did not match its migration`)
  }
}

async function resolveApplied(name) {
  await execFileAsync(process.execPath, [prismaCli, 'migrate', 'resolve', '--applied', name], {
    env: process.env,
  })
}

export async function prepareRun70Migrations(prisma, resolve = resolveApplied) {
  const baseTables = await prisma.$queryRaw`
    SELECT to_regclass('public.auth_users') IS NOT NULL AS "users",
      to_regclass('public.auth_invitations') IS NOT NULL AS "invitations",
      to_regclass('public.auth_rate_limits') IS NOT NULL AS "rateLimits",
      to_regclass('public._prisma_migrations') IS NOT NULL AS "ledger"
  `
  const base = baseTables[0]
  if (!base?.users && !base?.invitations && !base?.rateLimits) {
    // A fresh database builds the original indexes before application traffic.
    return 'fresh'
  }
  if (!base.users || !base.invitations || !base.rateLimits || !base.ledger) {
    throw new Error('Incomplete auth foundation; inspect migrations before RUN-70')
  }

  const firstApplied = await migrationApplied(prisma, firstMigration)
  if (!firstApplied) {
    await ensureColumns(prisma, columns.first, true)
    await resolve(firstMigration)
  } else {
    await ensureColumns(prisma, columns.first, false)
  }

  const secondApplied = await migrationApplied(prisma, secondMigration)
  if (secondApplied) return 'already-applied'
  await ensureColumns(prisma, columns.second, true)
  for (const index of indexes) await ensureIndex(prisma, index)
  await resolve(secondMigration)
  return 'prepared'
}

async function main() {
  const tier = process.env.APP_DATABASE_ENV
  const directUrl = process.env.DIRECT_URL
  if (!['development', 'production'].includes(tier) || !directUrl)
    throw new Error('Migration target environment is incomplete')
  const direct = new URL(directUrl)
  if (
    direct.hostname.includes('-pooler.') ||
    (direct.searchParams.get('schema') ?? 'public') !== 'public'
  )
    throw new Error('DIRECT_URL must use the direct public-schema connection')

  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } } })
  try {
    const identity = await prisma.databaseIdentity.findUnique({ where: { id: 1 } })
    if (identity?.tier !== (tier === 'production' ? 'PRODUCTION' : 'NON_PRODUCTION'))
      throw new Error('Database identity does not match migration environment')
    const result = await prepareRun70Migrations(prisma)
    process.stdout.write(`RUN-70 migration preparation: ${result}.\n`)
  } finally {
    await prisma.$disconnect()
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'RUN-70 preparation failed'}\n`,
    )
    process.exitCode = 1
  })
}
