export type ProviderConnectionStatus = {
  provider: 'GARMIN' | 'INTERVALS' | 'OPENAI'
  status: 'CONNECTED' | 'KEY_SAVED' | 'VERIFICATION_REQUIRED' | 'DISCONNECTED' | 'EXPIRED' | 'ERROR'
  createdAt: string | null
  updatedAt: string | null
}
