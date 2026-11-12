import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { APP_PATH_HEADER } from '@/lib/app-destination'
import { proxy } from './proxy'

describe('app path proxy', () => {
  it('forwards the real pathname instead of a client-supplied header', () => {
    const request = new NextRequest('https://coach.example/app/training', {
      headers: { [APP_PATH_HEADER]: '/app/admin' },
    })
    const response = proxy(request)
    expect(response.headers.get(`x-middleware-request-${APP_PATH_HEADER}`)).toBe('/app/training')
  })
})
