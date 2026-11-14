import type { ReactNode } from 'react'
import { renderProtectedPage } from '../protected-page'

export default async function GoalsLayout({ children }: { children: ReactNode }) {
  return renderProtectedPage(children)
}
