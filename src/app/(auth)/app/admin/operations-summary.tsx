import { Activity } from 'lucide-react'
import type { OperationalSummary } from '@/lib/operations'
import { Card } from '@/components/ui/Card'
import { SectionHeading } from '@/components/ui/SectionHeading'
import styles from './operations-summary.module.scss'

export function OperationsSummary({ summary }: { summary: OperationalSummary | null }) {
  return (
    <Card as="section" aria-labelledby="operations-title" className={styles.panel}>
      <SectionHeading icon={Activity} id="operations-title" title="Operational health" />
      {summary ? (
        <>
          <p>
            Sync issues in the last 24 hours and current publication issues. Reload this page to
            refresh.
          </p>
          <dl className={styles.counts}>
            <div>
              <dt>Stalled sync requests</dt>
              <dd>{summary.stalledSyncs}</dd>
            </div>
            <div>
              <dt>Queued or running publications over 5 minutes</dt>
              <dd>{summary.stalledPublications}</dd>
            </div>
          </dl>
          {[
            { label: 'Sync issues', groups: summary.syncFailures },
            { label: 'Publication issues', groups: summary.publicationFailures },
          ].map(({ label, groups }) => (
            <div key={label}>
              <h3>{label}</h3>
              {groups.length ? (
                <ul>
                  {groups.map(({ code, count }) => (
                    <li key={code}>
                      {code}: {count}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No issues recorded.</p>
              )}
            </div>
          ))}
          <p>
            Stalled requests need investigation; they may have been interrupted. Owners resume sync
            or recover publication explicitly.
          </p>
        </>
      ) : (
        <p role="status">
          Operational health is unavailable. Reload to retry; check deployment and database access
          if it persists.
        </p>
      )}
    </Card>
  )
}
