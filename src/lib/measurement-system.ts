export type MeasurementSystem = 'METRIC' | 'IMPERIAL'

export function normalizeMeasurementSystem(value: string | null | undefined): MeasurementSystem {
  return value === 'IMPERIAL' ? 'IMPERIAL' : 'METRIC'
}

export function weightUnitFor(system: MeasurementSystem): 'KG' | 'LB' {
  return system === 'IMPERIAL' ? 'LB' : 'KG'
}

export function formatWeight(valueKg: number, system: MeasurementSystem): string {
  const value = system === 'IMPERIAL' ? valueKg / 0.45359237 : valueKg
  return `${value.toFixed(1)} ${system === 'IMPERIAL' ? 'lb' : 'kg'}`
}

export function formatWeightDifference(valueKg: number, system: MeasurementSystem): string {
  const value = system === 'IMPERIAL' ? valueKg / 0.45359237 : valueKg
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${Math.abs(value).toFixed(1)} ${system === 'IMPERIAL' ? 'lb' : 'kg'}`
}
