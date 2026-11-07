'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { MeasurementSystem } from '@/lib/measurement-system'

type MeasurementSystemContextValue = {
  system: MeasurementSystem
  setSystem: (system: MeasurementSystem) => void
}

const MeasurementSystemContext = createContext<MeasurementSystemContextValue | null>(null)

export function MeasurementSystemProvider({
  initialSystem,
  children,
}: {
  initialSystem: MeasurementSystem
  children: ReactNode
}) {
  const [system, setSystem] = useState(initialSystem)
  return (
    <MeasurementSystemContext.Provider value={{ system, setSystem }}>
      {children}
    </MeasurementSystemContext.Provider>
  )
}

export function useMeasurementSystem() {
  const value = useContext(MeasurementSystemContext)
  if (!value) throw new Error('Measurement system provider is required')
  return value
}
