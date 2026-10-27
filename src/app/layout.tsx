import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Running Coach',
  description: 'Private endurance planning, built with care.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="site-header">
            <Link className="brand" href="/" aria-label="Running Coach home">
              <span className="brand-mark" aria-hidden="true">
                ↗
              </span>
              Running Coach
            </Link>
            <nav aria-label="Main navigation">
              <Link href="/">Home</Link>
              <Link href="/status">Status</Link>
            </nav>
          </header>
          <main id="main-content">{children}</main>
          <footer className="site-footer">
            <span>Running Coach</span>
            <span>Private training plans are coming soon.</span>
          </footer>
        </div>
      </body>
    </html>
  )
}
