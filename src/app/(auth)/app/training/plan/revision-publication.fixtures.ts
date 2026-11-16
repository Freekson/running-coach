import type { RevisionPublicationPreview } from '@/lib/plan-publication'
import { refreshChoice, refreshPreview } from './refresh/plan-refresh.fixtures'

export const publicationPreviewFixture: RevisionPublicationPreview = {
  planId: refreshChoice.id,
  revisionId: refreshChoice.revisionId,
  changes: refreshPreview.preview.refresh!.changes.map((change, index) => ({
    ...change,
    kind: change.kind === 'unchanged' ? 'changed' : change.kind,
    after:
      change.kind === 'unchanged' ? { ...change.after, scheduledDate: '2026-11-20' } : change.after,
    operation:
      change.kind === 'created' ? 'CREATE' : change.kind === 'canceled' ? 'CANCEL' : 'RESCHEDULE',
    reviewToken: String(index + 1).repeat(64),
    expectedPublishRevision: change.before ? 1 : 0,
    status: change.before ? 'PUBLISHED' : null,
    baselineStatus: change.before ? 'confirmed' : 'not_published',
    remoteStateUncertain: false,
  })),
}
