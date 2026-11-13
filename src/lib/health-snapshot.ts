export type HealthReading = { value: number; date: string; timezone: string; fetchedAt: string }

export type HealthSnapshotData = {
  restingHr: HealthReading | null
  sleep: HealthReading | null
  sleepScore?: HealthReading | null
  restingHrChecked: boolean
  sleepChecked: boolean
  lastUpdatedAt: string | null
}
