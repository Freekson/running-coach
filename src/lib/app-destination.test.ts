import { describe, expect, it } from 'vitest'
import { safeAppDestination } from './app-destination'

describe('post-login destination', () => {
  it('keeps valid authenticated paths', () => {
    expect(safeAppDestination('/app')).toBe('/app')
    expect(safeAppDestination('/app/dashboard')).toBe('/app/dashboard')
    expect(safeAppDestination('/app/training/workout-123')).toBe('/app/training/workout-123')
  })

  it('falls back to the dashboard for external or malformed paths', () => {
    for (const path of [
      null,
      'https://example.com',
      '//example.com',
      '/app/\\example.com',
      '/app/%2f%2fexample.com',
      '/app/../sign-in',
      '/application',
      '/app?next=https://example.com',
    ]) {
      expect(safeAppDestination(path)).toBe('/app/dashboard')
    }
  })
})
