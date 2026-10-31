import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { bodyFont, headingFont } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'Running Coach',
  description: 'Private endurance planning, built with care.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${headingFont.variable} ${bodyFont.variable}`}>
      <body>
        <div className="site-shell">
          <header className="site-header">
            <Link className="brand" href="/" aria-label="Running Coach home">
              <span className="brand-mark" aria-hidden="true">
                ↗
              </span>
              <span className="brand-name">Running Coach</span>
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
