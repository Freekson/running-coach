import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PrismaClient } from '@prisma/client'

const run = promisify(execFile)
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js')
const root = fileURLToPath(new URL('../../', import.meta.url))

// This drill has no target argument and never loads .env or uses an existing DB.
// All state, including the logical dump, lives in this disposable container.
async function main() {
  const name = `run53-recovery-${randomUUID()}`
  let container
  let source
  let restored
  let phase = 'create disposable PostgreSQL'
  const started = Date.now()
  try {
    const created = await run(
      'docker',
      [
        'run',
        '--detach',
        '--name',
        name,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_PASSWORD=synthetic-recovery-only',
        '--env',
        'POSTGRES_DB=source',
        'postgres:18-alpine',
      ],
      { timeout: 120_000 },
    )
    container = created.stdout.trim()
    assert.match(container, /^[a-f0-9]{64}$/)
    const docker = (args) => run('docker', ['exec', container, ...args], { timeout: 60_000 })
    phase = 'wait for disposable PostgreSQL'
    for (let attempt = 0; ; attempt++) {
      try {
        await docker([
          'env',
          'PGPASSWORD=synthetic-recovery-only',
          'psql',
          '-X',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          'source',
          '--set=ON_ERROR_STOP=1',
          '--tuples-only',
          '--command=SELECT 1',
        ])
        break
      } catch {
        if (attempt >= 30) throw new Error('not ready')
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    const { stdout } = await run('docker', ['port', container, '5432/tcp'])
    const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)
    assert.ok(match)
    const url = (database) =>
      `postgresql://postgres:synthetic-recovery-only@127.0.0.1:${match[1]}/${database}`
    const cli = (database, args) =>
      run(process.execPath, [prismaCli, ...args], {
        cwd: root,
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_URL: url(database),
          DIRECT_URL: url(database),
          APP_DATABASE_ENV: 'test',
        },
      })
    phase = 'migrate clean source database'
    await cli('source', ['migrate', 'deploy'])
    phase = 'seed synthetic storage fixtures'
    source = new PrismaClient({ datasourceUrl: url('source') })
    await source.databaseIdentity.create({ data: { id: 1, tier: 'NON_PRODUCTION' } })
    const survivor = await source.user.create({ data: { authSubject: randomUUID() } })
    const deletedAuth = await source.authUser.create({
      data: { id: randomUUID(), name: 'Synthetic deleted', email: 'deleted@example.test' },
    })
    const deleted = await source.user.create({ data: { authSubject: deletedAuth.id } })
    const connection = await source.integrationConnection.create({
      data: {
        userId: survivor.id,
        provider: 'GARMIN',
        authMethod: 'API_KEY',
        status: 'CONNECTED',
      },
    })
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const aad = Buffer.from(`${survivor.id}:${connection.id}:GARMIN:API_KEY`)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update('synthetic-provider-key'), cipher.final()])
    await source.integrationCredential.create({
      data: {
        userId: survivor.id,
        connectionId: connection.id,
        ciphertext,
        nonce,
        authTag: cipher.getAuthTag(),
        encryptionKeyVersion: 1,
      },
    })
    await source.bodyMeasurement.create({
      data: {
        userId: survivor.id,
        measuredAt: new Date(),
        measurementType: 'WEIGHT',
        value: 70,
        unit: 'kg',
        source: 'MANUAL',
      },
    })
    await source.syncCursor.create({
      data: {
        userId: survivor.id,
        connectionId: connection.id,
        dataType: 'recovery-fixture',
        cursorOrCheckpoint: { nextDate: '2026-11-01' },
      },
    })
    const goal = await source.goal.create({
      data: {
        userId: survivor.id,
        name: 'Synthetic recovery',
        type: 'COMPLETION',
        surface: 'ROAD',
      },
    })
    const plan = await source.trainingPlan.create({
      data: { userId: survivor.id, goalId: goal.id },
    })
    const draft = await source.planDraft.create({
      data: {
        userId: survivor.id,
        goalId: goal.id,
        planId: plan.id,
        sessionsPerWeek: 3,
        availableWeekdays: [1, 3, 5],
        timezone: 'UTC',
      },
    })
    // Storage fixture only; domain-valid JSON roundtrip is covered by test:db.
    const snapshot = { synthetic: true, immutable: 'recovery snapshot' }
    const revision = await source.planRevision.create({
      data: {
        userId: survivor.id,
        goalId: goal.id,
        planId: plan.id,
        sourceDraftId: draft.id,
        revisionNumber: 1,
        snapshot,
      },
    })
    await source.trainingPlan.update({
      where: { id: plan.id },
      data: { currentRevisionId: revision.id },
    })
    await source.workoutPublication.create({
      data: {
        userId: survivor.id,
        localWorkoutId: randomUUID(),
        approvedRevisionId: revision.id,
        publishRevision: 1,
        operation: 'CREATE',
        status: 'UNCERTAIN',
        externalId: randomUUID(),
        payloadHash: 'a'.repeat(64),
        payload: { synthetic: true },
        errorCode: 'RECOVERY_REQUIRED',
      },
    })
    phase = 'backup and restore into a different empty database'
    await docker([
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'source',
      '--format=custom',
      '--file=/tmp/recovery.dump',
    ])
    // The latest receipt is deliberately newer than the backup.
    const receipt = {
      userId: deleted.id,
      authSubjectHash: createHash('sha256').update(deletedAuth.id).digest('hex'),
      deletedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    }
    await docker(['createdb', '-U', 'postgres', 'restored'])
    await docker([
      'pg_restore',
      '-U',
      'postgres',
      '-d',
      'restored',
      '--exit-on-error',
      '--no-owner',
      '/tmp/recovery.dump',
    ])
    await cli('restored', ['migrate', 'status'])
    await cli('restored', ['migrate', 'deploy'])
    restored = new PrismaClient({ datasourceUrl: url('restored') })
    assert.equal(
      (await restored.databaseIdentity.findUniqueOrThrow({ where: { id: 1 } })).tier,
      'NON_PRODUCTION',
    )
    assert.equal(await restored.user.count(), 2)
    assert.deepEqual(
      (await restored.planRevision.findUniqueOrThrow({ where: { id: revision.id } })).snapshot,
      snapshot,
    )
    assert.equal(
      (await restored.trainingPlan.findUniqueOrThrow({ where: { id: plan.id } })).currentRevisionId,
      revision.id,
    )
    assert.equal(
      (await restored.syncCursor.findFirstOrThrow()).cursorOrCheckpoint.nextDate,
      '2026-11-01',
    )
    assert.equal((await restored.workoutPublication.findFirstOrThrow()).status, 'UNCERTAIN')
    assert.equal(await restored.bodyMeasurement.count(), 1)
    phase = 'verify historical encryption key and replay post-backup deletion'
    const encrypted = await restored.integrationCredential.findUniqueOrThrow({
      where: { connectionId: connection.id },
    })
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(encrypted.authTag)
    assert.equal(
      Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString(),
      'synthetic-provider-key',
    )
    await restored.accountDeletionReceipt.create({ data: receipt })
    await cli('restored', [
      'db',
      'execute',
      '--schema',
      'prisma/scripts/direct.prisma',
      '--file',
      'prisma/scripts/replay-account-deletions.sql',
    ])
    await cli('restored', [
      'db',
      'execute',
      '--schema',
      'prisma/scripts/direct.prisma',
      '--file',
      'prisma/scripts/replay-account-deletions.sql',
    ])
    assert.equal(await restored.user.count({ where: { id: deleted.id } }), 0)
    assert.equal(await restored.authUser.count({ where: { id: deletedAuth.id } }), 0)
    assert.equal(await restored.user.count({ where: { id: survivor.id } }), 1)
    console.info(
      `Recovery drill passed: clean migration, dump/restore, ledger, snapshot, checkpoint, uncertain publication, key and deletion replay (${Math.ceil((Date.now() - started) / 1000)}s).`,
    )
  } catch {
    // Child process exceptions include arguments, environment and DB diagnostics.
    console.error(`Recovery drill failed during: ${phase}. No existing database was targeted.`)
    process.exitCode = 1
  } finally {
    await source?.$disconnect()
    await restored?.$disconnect()
    if (container && /^[a-f0-9]{64}$/.test(container)) {
      try {
        await run('docker', ['rm', '--force', '--volumes', container], { timeout: 30_000 })
      } catch {
        console.error(`Remove disposable recovery container ${name} manually.`)
        process.exitCode = 1
      }
    }
  }
}

await main()
