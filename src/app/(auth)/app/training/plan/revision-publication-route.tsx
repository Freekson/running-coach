'use client'

import { RevisionPublication } from './revision-publication'
import { previewRevisionPublicationAction, sendRevisionPublicationAction } from './new/actions'

export function RevisionPublicationRoute(props: { planId: string; revisionId: string }) {
  return (
    <RevisionPublication
      {...props}
      onPreview={previewRevisionPublicationAction}
      onSend={sendRevisionPublicationAction}
    />
  )
}
