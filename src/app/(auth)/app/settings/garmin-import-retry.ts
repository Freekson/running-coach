const firstRateLimitDelayMs = 60_000
const maxRateLimitDelayMs = 60 * 60_000

/** Keep the server's retry time as a floor while spacing repeated 429s farther apart. */
export function nextGarminRateLimitRetryAt(
  nowMs: number,
  consecutiveLimits: number,
  serverRetryAt: string | null,
): string {
  const exponent = Math.min(Math.max(consecutiveLimits - 1, 0), 6)
  const delayMs = Math.min(maxRateLimitDelayMs, firstRateLimitDelayMs * 2 ** exponent)
  const serverTime = serverRetryAt ? Date.parse(serverRetryAt) : NaN
  return new Date(
    Math.max(nowMs + delayMs, Number.isFinite(serverTime) ? serverTime : 0),
  ).toISOString()
}
