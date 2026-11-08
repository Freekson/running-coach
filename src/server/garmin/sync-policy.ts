import 'server-only'

import { getDeploymentKind } from '@/lib/deployment'

export function isGarminImportAllowed(): boolean {
  return (
    (process.env.NODE_ENV !== 'production' &&
      getDeploymentKind(process.env.VERCEL_ENV) === 'local') ||
    process.env.GARMIN_SHARED_SYNC_APPROVED === 'true'
  )
}
