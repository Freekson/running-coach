import type { ExchangeRequest } from '@/schemas/plan-exchange.v1'
import styles from './plan-export.module.scss'

export function ContextPreview({ json }: { json: string }) {
  const { request } = JSON.parse(json) as { request: ExchangeRequest }
  const context = request.trainingContext
  const coverage = context.activityHistoryCoverage
  return (
    <section aria-label="Training context summary">
      <p>
        Recorded history coverage: {coverage.status}. Last manual sync:{' '}
        {coverage.lastManualSyncAt ?? 'Unknown'}.
      </p>
      <p>
        Historical import: {coverage.historicalImport?.status ?? 'Unknown'}. Most recent recorded
        run: {context.lastRecordedRunAt ?? 'Unknown or excluded'}.
      </p>
      <p>
        Experience:{' '}
        {context.athleteReport?.experience.replaceAll('_', ' ') ?? 'Unknown or excluded'}. First
        workout ever:{' '}
        {context.athleteReport?.firstWorkoutEver === undefined ||
        context.athleteReport.firstWorkoutEver === null
          ? 'Unknown'
          : context.athleteReport.firstWorkoutEver
            ? 'Yes, reported by athlete'
            : 'No, reported by athlete'}
        .
      </p>
      <div className={styles.tableWrap}>
        <table>
          <caption>Recent running volume from covered history</caption>
          <thead>
            <tr>
              <th scope="col">Window</th>
              <th scope="col">Distance</th>
              <th scope="col">Sessions</th>
              <th scope="col">Elapsed duration</th>
            </tr>
          </thead>
          <tbody>
            {context.recentTrainingSummary.rollingTotals.map((total) => (
              <tr key={total.weeks}>
                <th scope="row">{total.weeks} weeks</th>
                <td>
                  {total.distance.value === null
                    ? 'Unknown or excluded'
                    : `${(total.distance.value / (request.measurementSystem === 'IMPERIAL' ? 1609.344 : 1000)).toFixed(1)} ${request.measurementSystem === 'IMPERIAL' ? 'mi' : 'km'}`}
                </td>
                <td>{total.completedSessions.value ?? 'Unknown or excluded'}</td>
                <td>
                  {total.duration.value === null
                    ? 'Unknown or excluded'
                    : `${Math.round(total.duration.value / 60)} min`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {context.recentRunSamples.length} representative runs; {context.selection.truncatedRuns}{' '}
        runs and {context.selection.truncatedLaps} laps omitted by limits;{' '}
        {context.selection.excludedDuplicateCandidates} unresolved duplicate candidates excluded.
        Counts are withheld when their data category is excluded.
      </p>
      <p>
        {coverage.failedWindows.length} failed coverage windows; {coverage.unfetchedWindows.length}{' '}
        unfetched windows. Inspect their dates in the exact request below.
      </p>
      <p>
        Recovery:{' '}
        {context.recoveryContext
          ? `${context.recoveryContext.days.length} dated observations; ${context.recoveryContext.coverage.status} coverage. These are optional observations, not a clinical safety assessment.`
          : 'Excluded'}
        .
      </p>
      {request.mode === 'refresh' && (
        <p>
          Refresh revision {request.currentApprovedRevision.revisionNumber}:{' '}
          {request.currentApprovedRevision.workouts.filter((w) => w.outcome === 'completed').length}{' '}
          included completed sessions,{' '}
          {request.currentApprovedRevision.workouts.filter((w) => w.lockedAt).length} locked
          sessions. Outcomes without reliable completion evidence remain unknown. Phase dates and
          required commitments are included below; approved-plan free text is withheld for privacy.{' '}
          {request.currentApprovedRevision.omittedHistoricalCommitments ?? 0} historical commitments
          omitted ({request.currentApprovedRevision.commitmentsCoverage} coverage).
        </p>
      )}
    </section>
  )
}
