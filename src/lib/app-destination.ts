const appPath = /^\/app(?:\/[a-z0-9-]+)*$/

export const APP_PATH_HEADER = 'x-running-coach-app-path'

// Keep post-login navigation inside the authenticated route tree. Queries,
// fragments and encoded separators are intentionally excluded.
export function safeAppDestination(value: string | null): string {
  return value && appPath.test(value) ? value : '/app/dashboard'
}
