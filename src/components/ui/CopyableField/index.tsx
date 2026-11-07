'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { Check, CircleX, Copy } from 'lucide-react'
import { Input } from '../FormField'
import styles from './CopyableField.module.scss'

export type CopyableFieldProps = {
  id: string
  label: string
  value: string
  disabled?: boolean
  onCopyError?: () => void
  onCopySuccess?: () => void
}

export async function copyValue(value: string, writeText: (text: string) => Promise<void>) {
  try {
    await writeText(value)
    return true
  } catch {
    return false
  }
}

/** A selectable read-only field with a copy action; callbacks may show a Toast. */
export function CopyableField({
  id,
  label,
  value,
  disabled = false,
  onCopyError,
  onCopySuccess,
}: CopyableFieldProps) {
  const [previous, setPrevious] = useState({ value, disabled })
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [copying, setCopying] = useState(false)
  if (previous.value !== value || previous.disabled !== disabled) {
    setPrevious({ value, disabled })
    setState('idle')
    setCopying(false)
  }
  const ActionIcon = state === 'copied' ? Check : state === 'failed' ? CircleX : Copy
  const copyInProgress = useRef(false)
  const generation = useRef(0)
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    return () => {
      generation.current += 1
      copyInProgress.current = false
      if (reset.current) {
        clearTimeout(reset.current)
        reset.current = null
      }
    }
  }, [value, disabled])

  async function copy() {
    if (!value || disabled || copyInProgress.current) return
    copyInProgress.current = true
    setCopying(true)
    setState('idle')
    if (reset.current) clearTimeout(reset.current)
    const currentGeneration = generation.current
    const copied = await copyValue(value, (text) => navigator.clipboard.writeText(text))
    if (generation.current !== currentGeneration) return
    copyInProgress.current = false
    setCopying(false)
    if (copied) {
      setState('copied')
    } else {
      setState('failed')
    }
    reset.current = setTimeout(() => setState('idle'), 2500)
    if (copied) onCopySuccess?.()
    else onCopyError?.()
  }

  return (
    <div className={styles.group}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.control}>
        <Input
          id={id}
          value={value}
          readOnly
          disabled={disabled}
          onFocus={(event) => event.target.select()}
        />
        <button
          type="button"
          className={[
            styles.copy,
            state === 'copied' && styles.copied,
            state === 'failed' && styles.failed,
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={copy}
          disabled={disabled || !value}
          aria-disabled={copying || undefined}
          aria-busy={copying || undefined}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        >
          <ActionIcon size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
        </button>
      </div>
      <span
        className={[styles.feedback, state === 'failed' && styles.feedbackError]
          .filter(Boolean)
          .join(' ')}
        role="status"
      >
        {state === 'copied'
          ? 'Copied.'
          : state === 'failed'
            ? 'Copy failed. Select the field to copy manually.'
            : ''}
      </span>
    </div>
  )
}
