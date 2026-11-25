import 'server-only'

import type { OperationalSummary } from '@/lib/operations'
import { requireAdmin } from '@/server/auth/admin-access'
import { getPrismaClient } from '@/server/db/client'
import { reportOperationalFailure, safeOperationalCode } from './events'

export class OperationalAccessError extends Error {
  constructor(readonly status: number) {
    super('Operational summary access denied')
  }
}

function totals(groups: { errorCode: string | null; _count: { _all: number } }[]) {
  const counts = new Map<string, number>()
  for (const group of groups) {
    const code = safeOperationalCode(group.errorCode)
    counts.set(code, (counts.get(code) ?? 0) + group._count._all)
  }
  return [...counts]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** Global operational aggregates are explicitly admin-only; no athlete drilldown. */
export async function getOperationalSummary(): Promise<OperationalSummary | null> {
  const denied = await requireAdmin()
  if (denied) throw new OperationalAccessError(denied.status)
  try {
    const prisma = await getPrismaClient()
    const now = new Date()
    const since = new Date(now.getTime() - 86_400_000)
    const stalledBefore = new Date(now.getTime() - 300_000)
    const [syncs, publications, stalledSyncs, stalledPublications] = await Promise.all([
      prisma.syncRun.groupBy({
        by: ['errorCode'],
        where: {
          startedAt: { gte: since },
          OR: [{ status: 'FAILED' }, { errorCode: { not: null } }],
        },
        _count: { _all: true },
      }),
      prisma.workoutPublication.groupBy({
        by: ['errorCode'],
        where: { status: { in: ['FAILED', 'UNCERTAIN', 'INTERRUPTED', 'SUPERSEDED'] } },
        _count: { _all: true },
      }),
      prisma.syncRun.count({ where: { status: 'RUNNING', startedAt: { lt: stalledBefore } } }),
      prisma.workoutPublication.count({
        where: { status: { in: ['RUNNING', 'QUEUED'] }, updatedAt: { lt: stalledBefore } },
      }),
    ])
    return {
      since: since.toISOString(),
      checkedAt: now.toISOString(),
      syncFailures: totals(syncs),
      publicationFailures: totals(publications),
      stalledSyncs,
      stalledPublications,
    }
  } catch {
    reportOperationalFailure('admin_summary', 'STORAGE_UNAVAILABLE')
    return null
  }
}
