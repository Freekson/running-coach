const appPath = /^\/app(?:\/[a-z0-9-]+)*$/

// Keep post-login navigation inside the authenticated route tree. Queries,
// fragments and encoded separators are intentionally excluded.
export function safeAppDestination(value: string | null): string {
  return value && appPath.test(value) ? value : '/app/dashboard'
}
