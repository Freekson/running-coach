import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:util', async (original) => ({ ...(await original()), promisify: () => mocks.run }))
let previousExitCode
beforeEach(() => {
  vi.resetModules()
  previousExitCode = process.exitCode
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  process.exitCode = previousExitCode
  vi.restoreAllMocks()
  mocks.run.mockReset()
})

it('redacts process errors and does not remove an unidentified container', async () => {
  mocks.run.mockRejectedValue(new Error('postgresql://password@private-db secret-health-record'))
  await import('./test-recovery.mjs')
  expect(process.exitCode).toBe(1)
  expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('password')
})

it('removes only its own container after an invalid loopback port prevents migration', async () => {
  const container = 'a'.repeat(64)
  mocks.run
    .mockResolvedValueOnce({ stdout: container })
    .mockResolvedValueOnce({ stdout: 'ready' })
    .mockResolvedValueOnce({ stdout: '0.0.0.0:5432' })
    .mockResolvedValueOnce({ stdout: '' })
  await import('./test-recovery.mjs')
  expect(process.exitCode).toBe(1)
  expect(mocks.run).toHaveBeenLastCalledWith('docker', ['rm', '--force', '--volumes', container], {
    timeout: 30_000,
  })
  expect(mocks.run.mock.calls.every(([command]) => command === 'docker')).toBe(true)
})

it('waits for an authenticated TCP query before advancing to migrations', async () => {
  const container = 'b'.repeat(64)
  vi.useFakeTimers()
  try {
    mocks.run
      .mockResolvedValueOnce({ stdout: container })
      .mockRejectedValueOnce(new Error('TCP unavailable while the initialization socket is ready'))
      .mockResolvedValueOnce({ stdout: '1' })
      .mockResolvedValueOnce({ stdout: '127.0.0.1:54321' })
      .mockRejectedValueOnce(new Error('stop before running migrations'))
      .mockResolvedValueOnce({ stdout: '' })
    const drill = import('./test-recovery.mjs')
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2))
    expect(mocks.run.mock.calls[1]).toEqual([
      'docker',
      [
        'exec',
        container,
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
      ],
      { timeout: 60_000 },
    ])
    await vi.advanceTimersByTimeAsync(1000)
    await drill
    expect(mocks.run.mock.calls[2]).toEqual(mocks.run.mock.calls[1])
    expect(mocks.run.mock.calls[3][1]).toEqual(['port', container, '5432/tcp'])
    expect(mocks.run.mock.calls[4][1]).toEqual(expect.arrayContaining(['migrate', 'deploy']))
  } finally {
    vi.useRealTimers()
  }
})
