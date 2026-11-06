import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToastViewport } from './Toast'
import { redirectNotice, toastRedirectPath } from './toast-redirect'

describe('redirect notifications', () => {
  it('maps only allowlisted codes to static copy', () => {
    expect(redirectNotice('missing-invite')).toEqual({
      tone: 'error',
      message: 'An invitation link is required to create an account.',
    })
    expect(redirectNotice('<script>alert(1)</script>')).toBeNull()
    expect(redirectNotice('__proto__')).toBeNull()
    expect(redirectNotice(null)).toBeNull()
  })

  it('builds only local redirect paths', () => {
    expect(toastRedirectPath('/?next=%2Fapp', 'missing-invite')).toBe(
      '/?next=%2Fapp&notice=missing-invite',
    )
    expect(() => toastRedirectPath('https://external.example/', 'missing-invite')).toThrow()
  })
})

describe('ToastViewport', () => {
  it('uses appropriate live roles and labeled dismiss buttons', () => {
    const html = renderToStaticMarkup(
      <ToastViewport
        toasts={[
          { id: 1, tone: 'success', message: 'Saved' },
          { id: 2, tone: 'error', message: 'Failed' },
          { id: 3, tone: 'warning', message: 'Expiring' },
          { id: 4, tone: 'info', message: 'Ready to review' },
        ]}
        onDismiss={() => {}}
      />,
    )
    expect(html.match(/role="status"/g)).toHaveLength(2)
    expect(html.match(/role="alert"/g)).toHaveLength(2)
    expect(html).toContain('Dismiss notification: Saved')
    expect(html).toContain('Dismiss notification: Failed')
    expect(html).toContain('lucide-circle-check')
    expect(html).toContain('lucide-circle-x')
    expect(html).toContain('lucide-triangle-exclamation-point')
    expect(html).toContain('lucide-info')
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(8)
  })
})
