'use client'

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <section className="status-panel" aria-labelledby="error-heading">
      <div className="eyebrow">App error</div>
      <h1 id="error-heading">Something went wrong.</h1>
      <p>We couldn&apos;t load this page. Please try again.</p>
      <button className="button" type="button" onClick={retry}>
        Try again
      </button>
    </section>
  )
}
