export type ToastTone = 'success' | 'error' | 'warning' | 'info'

const redirectNotices = {
  'missing-invite': {
    tone: 'error',
    message: 'An invitation link is required to create an account.',
  },
} as const satisfies Record<string, { tone: ToastTone; message: string }>

/** Only known codes become messages; URL values are never displayed as text. */
export function redirectNotice(code: string | null): { tone: ToastTone; message: string } | null {
  if (code && Object.hasOwn(redirectNotices, code)) {
    return redirectNotices[code as keyof typeof redirectNotices]
  }
  return null
}

/** Safe for server redirects and client router navigation. */
export function toastRedirectPath(path: string, code: keyof typeof redirectNotices): string {
  const url = new URL(path, 'https://running-coach.invalid')
  if (url.origin !== 'https://running-coach.invalid') {
    throw new Error('Toast redirects must be local')
  }
  url.searchParams.set('notice', code)
  return `${url.pathname}${url.search}${url.hash}`
}
