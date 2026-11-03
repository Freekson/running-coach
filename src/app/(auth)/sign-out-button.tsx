'use client'

import { useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { useRouter } from 'next/navigation'

export function SignOutButton() {
  const router = useRouter()
  const [error, setError] = useState('')
  return (
    <div>
      <button
        className="button"
        type="button"
        onClick={async () => {
          setError('')
          const result = await authClient.signOut()
          if (result.error) {
            setError('Sign out failed. Please try again.')
            return
          }
          router.replace('/sign-in')
          router.refresh()
        }}
      >
        Sign out
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
