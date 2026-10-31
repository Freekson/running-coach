'use client'

import { bodyFont, headingFont } from './fonts'
import './globals.css'

export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" className={`${headingFont.variable} ${bodyFont.variable}`}>
      <body>
        <div className="site-shell">
          <main id="main-content">
            <section className="status-panel" aria-labelledby="error-heading">
              <div className="eyebrow">App error</div>
              <h1 id="error-heading">Something went wrong.</h1>
              <p>We couldn&apos;t load this page. Please try again.</p>
              <button className="button" type="button" onClick={retry}>
                Try again
              </button>
            </section>
          </main>
        </div>
      </body>
    </html>
  )
}
