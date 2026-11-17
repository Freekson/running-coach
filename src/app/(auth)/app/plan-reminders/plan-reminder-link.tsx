'use client'

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { ButtonLink } from '@/components/ui/Button'
import { useNavigationGuard } from '../navigation-guard'

export function PlanReminderLink({
  href,
  disabled,
  children,
}: {
  href: string
  disabled?: boolean
  children: ReactNode
}) {
  const router = useRouter()
  const { requestLeave } = useNavigationGuard()
  return (
    <ButtonLink
      href={href}
      variant="secondary"
      size="compact"
      disabled={disabled}
      onNavigate={(event) => {
        if (requestLeave(() => router.push(href))) event.preventDefault()
      }}
    >
      {children}
    </ButtonLink>
  )
}
