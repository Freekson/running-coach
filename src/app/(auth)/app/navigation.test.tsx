import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'

const { usePathname, useRouter } = vi.hoisted(() => ({
  usePathname: vi.fn(),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}))

vi.mock('next/navigation', () => ({ usePathname, useRouter }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../sign-out-button', () => ({ SignOutButton: () => <button>Sign out</button> }))

import { AppNavigation } from './navigation'
import { AppShell } from './app-shell'

beforeEach(() => usePathname.mockReturnValue('/app/dashboard'))

describe('app navigation', () => {
  it('shows only existing user routes and marks the active section', () => {
    const markup = renderToStaticMarkup(<AppNavigation role="USER" />)
    for (const route of ['dashboard', 'training', 'calendar', 'goals', 'settings']) {
      expect(markup).toContain(`href="/app/${route}"`)
    }
    expect(markup).not.toContain('/app/admin')
    expect(markup).toContain('href="/app/dashboard"')
    expect(markup).toMatch(/href="\/app\/dashboard"[^>]*aria-current="page"/)
  })

  it('shows Admin only for an admin and tracks nested routes', () => {
    usePathname.mockReturnValue('/app/admin/invitations')
    const markup = renderToStaticMarkup(<AppNavigation role="ADMIN" />)
    expect(markup).toMatch(/href="\/app\/admin"[^>]*aria-current="page"/)
    expect(markup.match(/href="\/app\/admin"/g)).toHaveLength(1)
  })

  it('shows an email fallback and sign-out when the user has no name', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        user={{ id: 'user-a', role: 'USER', email: 'a@example.test' }}
        measurementSystem="METRIC"
      >
        <h1>Dashboard</h1>
      </AppShell>,
    )
    expect(markup).toContain('a@example.test')
    expect(markup).toContain('Signed in as')
    expect(markup).toMatch(/aria-hidden="true">A<\/span>/)
    expect(markup).toContain('Sign out')
    expect(markup).toContain('<h1>Dashboard</h1>')
  })

  it('shows the user name and its initial without exposing email in the sidebar', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        user={{ id: 'user-a', role: 'USER', email: 'a@example.test', name: 'Avery Runner' }}
        measurementSystem="METRIC"
      >
        <h1>Dashboard</h1>
      </AppShell>,
    )
    expect(markup).toContain('Signed in as')
    expect(markup).toContain('Avery Runner')
    expect(markup).toMatch(/aria-hidden="true">A<\/span>/)
    expect(markup).not.toContain('a@example.test')
  })

  it('prefers the saved display name over the registration name and email', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        user={{
          id: 'user-a',
          role: 'USER',
          email: 'a@example.test',
          name: 'Avery Runner',
          displayName: 'Trail Runner',
        }}
        measurementSystem="METRIC"
      >
        <h1>Dashboard</h1>
      </AppShell>,
    )
    expect(markup).toContain('Trail Runner')
    expect(markup).toMatch(/aria-hidden="true">T<\/span>/)
    expect(markup).not.toContain('Avery Runner')
    expect(markup).not.toContain('a@example.test')
  })

  it('shows admin access in navigation without a role badge in the account block', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        user={{ id: 'admin-a', role: 'ADMIN', email: 'admin@example.test' }}
        measurementSystem="METRIC"
      >
        <h1>Dashboard</h1>
      </AppShell>,
    )
    expect(markup).toContain('href="/app/admin"')
    expect(markup).not.toContain('badge--admin')
    expect(markup).not.toContain('ADMIN')
  })
})
