import Link from 'next/link'

export default function HomePage() {
  return (
    <section className="hero" aria-labelledby="hero-heading">
      <div className="eyebrow">A calmer way to train</div>
      <h1 id="hero-heading">Make room for the miles that matter.</h1>
      <p className="hero-copy">
        Running Coach is taking shape as a private space to plan endurance training, review your
        progress, and keep your next session in view.
      </p>
      <Link className="button" href="/status">
        Check app status <span aria-hidden="true">→</span>
      </Link>
      <div className="feature-grid">
        <article className="card feature-card">
          <span className="feature-number">01</span>
          <h2>Plan with purpose</h2>
          <p>Build toward a goal with sessions that fit real life.</p>
        </article>
        <article className="card feature-card">
          <span className="feature-number">02</span>
          <h2>Stay in control</h2>
          <p>Review every plan before any workout is published.</p>
        </article>
        <article className="card feature-card">
          <span className="feature-number">03</span>
          <h2>Keep it personal</h2>
          <p>Your training data belongs to you.</p>
        </article>
      </div>
    </section>
  )
}
