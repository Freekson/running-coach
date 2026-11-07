export type ProviderConnectionStatus = {
  provider: 'GARMIN' | 'INTERVALS' | 'OPENAI'
  status: 'CONNECTED' | 'DISCONNECTED' | 'EXPIRED' | 'ERROR'
  createdAt: string | null
  updatedAt: string | null
}
