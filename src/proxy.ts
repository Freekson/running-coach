import { NextResponse, type NextRequest } from 'next/server'
import { APP_PATH_HEADER } from '@/lib/app-destination'

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(APP_PATH_HEADER, request.nextUrl.pathname)
  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = { matcher: '/app/:path*' }
