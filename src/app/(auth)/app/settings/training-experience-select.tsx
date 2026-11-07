'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import styles from './athlete-settings.module.scss'

export type TrainingExperience = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED'

const options: { value: TrainingExperience; label: string; description: string }[] = [
  { value: 'BEGINNER', label: 'Beginner', description: 'Starting a running routine' },
  { value: 'INTERMEDIATE', label: 'Intermediate', description: 'Training consistently' },
  { value: 'ADVANCED', label: 'Advanced', description: 'Structured training experience' },
]

export function TrainingExperienceSelect({
  value,
  onChange,
}: {
  value: TrainingExperience
  onChange: (value: TrainingExperience) => void
}) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const optionButtons = useRef<(HTMLButtonElement | null)[]>([])
  const selectedIndex = options.findIndex((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    optionButtons.current[selectedIndex]?.focus()
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePress)
  }, [open, selectedIndex])

  function handleOptionKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focusedIndex = optionButtons.current.findIndex(
      (option) => option === document.activeElement,
    )
    let nextIndex: number
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = (focusedIndex + 1) % options.length
        break
      case 'ArrowUp':
        nextIndex = (focusedIndex + options.length - 1) % options.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = options.length - 1
        break
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
        return
      default:
        return
    }
    event.preventDefault()
    optionButtons.current[nextIndex]?.focus()
  }

  return (
    <div
      ref={container}
      className={styles.experienceSelect}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <span id="profile-experience-label" className={styles.experienceLabel}>
        Training experience
      </span>
      <button
        ref={trigger}
        id="profile-experience"
        type="button"
        className={styles.experienceTrigger}
        aria-labelledby="profile-experience-label profile-experience"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'profile-experience-options' : undefined}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        {options[selectedIndex].label}
        <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div
          id="profile-experience-options"
          role="listbox"
          aria-labelledby="profile-experience-label"
          className={styles.experienceOptions}
          onKeyDown={handleOptionKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => {
                optionButtons.current[index] = element
              }}
              type="button"
              role="option"
              aria-selected={value === option.value}
              className={styles.experienceOption}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
