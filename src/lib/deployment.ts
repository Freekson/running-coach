export type DeploymentKind = 'local' | 'preview' | 'production'

export function getDeploymentKind(value: string | undefined): DeploymentKind {
  if (value === 'preview' || value === 'production') return value
  return 'local'
}
