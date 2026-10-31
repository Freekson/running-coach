import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(scriptPath), '../..')

export function verifyNonproductionTarget(env, expectedEndpoint) {
  if (
    !['development', 'test'].includes(env.APP_DATABASE_ENV) ||
    env.VERCEL_ENV ||
    !expectedEndpoint
  ) {
    throw new Error(
      'Nonproduction marking requires a local development/test environment and an endpoint',
    )
  }

  let direct
  let runtime
  try {
    direct = new URL(env.DIRECT_URL)
    runtime = new URL(env.DATABASE_URL)
  } catch {
    throw new Error('Both Neon database URLs are required for nonproduction marking')
  }

  const schema = (url) => url.searchParams.get('schema') || 'public'
  if (
    !['postgres:', 'postgresql:'].includes(direct.protocol) ||
    !['postgres:', 'postgresql:'].includes(runtime.protocol) ||
    !direct.hostname.endsWith('.neon.tech') ||
    direct.hostname.includes('-pooler.') ||
    direct.hostname !== expectedEndpoint ||
    runtime.hostname !== direct.hostname.replace('.', '-pooler.') ||
    direct.port !== runtime.port ||
    direct.pathname !== runtime.pathname ||
    schema(direct) !== 'public' ||
    schema(direct) !== schema(runtime)
  ) {
    throw new Error(
      'Neon endpoint or database target does not match the confirmed nonproduction project',
    )
  }
}

async function main() {
  await import('dotenv/config')
  verifyNonproductionTarget(process.env, process.argv[2])

  const require = createRequire(import.meta.url)
  const prismaCli = join(dirname(require.resolve('prisma/package.json')), 'build/index.js')
  const result = spawnSync(
    process.execPath,
    [
      prismaCli,
      'db',
      'execute',
      '--schema',
      'prisma/scripts/direct.prisma',
      '--file',
      'prisma/scripts/mark-nonproduction.sql',
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  )
  if (result.error) throw new Error('Prisma CLI could not be started')
  if (result.status !== 0) process.exitCode = result.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
