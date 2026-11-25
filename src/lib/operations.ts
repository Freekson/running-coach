export type OperationalSummary = {
  since: string
  checkedAt: string
  syncFailures: { code: string; count: number }[]
  publicationFailures: { code: string; count: number }[]
  stalledSyncs: number
  stalledPublications: number
}
