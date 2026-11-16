'use client'

import { Button } from '@/components/ui/Button'

export function RevisionSnapshot({
  json,
  revisionNumber,
}: {
  json: string
  revisionNumber: number
}) {
  return (
    <>
      <label htmlFor="revision-snapshot">Original approved snapshot JSON</label>
      <textarea id="revision-snapshot" className="field" rows={8} readOnly value={json} />
      <Button
        variant="secondary"
        onClick={() => {
          const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
          const link = document.createElement('a')
          link.href = url
          link.download = `approved-plan-revision-${revisionNumber}.json`
          link.click()
          URL.revokeObjectURL(url)
        }}
      >
        Download revision snapshot
      </Button>
    </>
  )
}
