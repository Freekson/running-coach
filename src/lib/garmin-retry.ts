/** Keep the server deadline as a floor and back off repeated rate-limit responses. */
export function nextGarminRateLimitRetryAt(
  nowMs: number,
  consecutiveLimits: number,
  serverRetryAt: string | null,
): string {
  const exponent = Math.min(Math.max(consecutiveLimits - 1, 0), 6)
  const delayMs = Math.min(3_600_000, 60_000 * 2 ** exponent)
  const serverTime = serverRetryAt ? Date.parse(serverRetryAt) : NaN
  return new Date(
    Math.max(nowMs + delayMs, Number.isFinite(serverTime) ? serverTime : 0),
  ).toISOString()
}

export function garminRetryAtFromHeader(value: string | null): string | null {
  if (!value) return null
  const seconds = Number(value)
  const timestamp =
    Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1_000 : Date.parse(value)
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** Abortable browser wait; long Retry-After values are never shortened or overflow timers. */
export async function waitForRetry(retryAt: string, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.parse(retryAt)
  if (!Number.isFinite(deadline)) return false
  while (!signal.aborted && Date.now() < deadline) {
    const remaining = Math.min(60_000, deadline - Date.now())
    const elapsed = await new Promise<boolean>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer)
        resolve(false)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(true)
      }, remaining)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    if (!elapsed) return false
  }
  return !signal.aborted
}
