import { spawnSync } from 'node:child_process'

// Run the same generation path that verifies committed artifacts in ordinary CI.
if (!process.env.npm_execpath) throw new Error('Run through pnpm contracts:generate')
const result = spawnSync(
  process.execPath,
  [
    process.env.npm_execpath,
    'exec',
    'vitest',
    'run',
    'src/server/plans/exchange/artifacts.test.ts',
  ],
  { stdio: 'inherit', env: { ...process.env, UPDATE_PLAN_EXCHANGE_ARTIFACTS: '1' } },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
