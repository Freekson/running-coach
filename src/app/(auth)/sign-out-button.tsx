'use client'

import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { useNavigationGuard } from './app/navigation-guard'

export function SignOutButton({
  className,
  showIcon = false,
}: {
  className?: string
  showIcon?: boolean
}) {
  const router = useRouter()
  const { requestLeave } = useNavigationGuard()
  const [error, setError] = useState('')
  async function signOut() {
    setError('')
    const result = await authClient.signOut()
    if (result.error) {
      setError('Sign out failed. Please try again.')
      return
    }
    router.replace('/sign-in')
    router.refresh()
  }
  return (
    <div>
      <Button
        variant="secondary"
        size="compact"
        className={className}
        onClick={() => {
          if (!requestLeave(() => void signOut())) void signOut()
        }}
      >
        {showIcon && <LogOut size={18} strokeWidth={2} aria-hidden="true" focusable="false" />}
        Sign out
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
