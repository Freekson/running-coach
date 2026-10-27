import Link from 'next/link'

export default function NotFound() {
  return (
    <section className="status-panel" aria-labelledby="not-found-heading">
      <div className="eyebrow">Page not found</div>
      <h1 id="not-found-heading">We couldn&apos;t find that page.</h1>
      <p>The address may have changed, or the page may no longer exist.</p>
      <Link className="button" href="/">
        Return home
      </Link>
    </section>
  )
}
