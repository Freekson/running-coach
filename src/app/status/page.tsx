import { getDeploymentKind } from '@/lib/deployment'

export const dynamic = 'force-dynamic'

export default function StatusPage() {
  const deployment = getDeploymentKind(process.env.VERCEL_ENV)

  return (
    <section className="status-panel" aria-labelledby="status-heading">
      <div className="eyebrow">Deployment smoke check</div>
      <h1 id="status-heading">The app is running.</h1>
      <p>This page confirms that the Running Coach web app rendered successfully.</p>
      <dl className="status-list">
        <div>
          <dt>App</dt>
          <dd>Ready</dd>
        </div>
        <div>
          <dt>Environment</dt>
          <dd>{deployment}</dd>
        </div>
      </dl>
      <p className="status-note">
        This page does not check authentication, database access, or providers.
      </p>
    </section>
  )
}
