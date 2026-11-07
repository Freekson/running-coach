'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronDown } from 'lucide-react'
import styles from './DateField.module.scss'

export type DateFieldProps = {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  max?: string
  min?: string
  optional?: boolean
  disabled?: boolean
  placeholder?: string
}

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function dateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return match
    ? { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) }
    : null
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function DateField({
  id,
  label,
  value,
  onChange,
  max,
  min,
  optional = false,
  disabled = false,
  placeholder = 'Choose a date',
}: DateFieldProps) {
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const calendar = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const initial = dateParts(
    value || max || isoDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()),
  )!
  const [year, setYear] = useState(initial.year)
  const [month, setMonth] = useState(initial.month)
  const selected = dateParts(value)
  const maxYear = dateParts(max ?? '')?.year ?? new Date().getFullYear() + 10
  const minYear = dateParts(min ?? '')?.year ?? 1900
  const years = Array.from(
    { length: Math.max(maxYear - minYear + 1, 1) },
    (_, index) => maxYear - index,
  )
  if (selected && !years.includes(selected.year)) years.push(selected.year)
  const firstWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  useEffect(() => {
    if (!open) return
    function closeOutside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  useEffect(() => {
    const parentDialog = root.current?.closest('dialog')
    if (!parentDialog) return
    const closeCalendar = () => setOpen(false)
    parentDialog.addEventListener('close', closeCalendar)
    return () => parentDialog.removeEventListener('close', closeCalendar)
  }, [])

  useLayoutEffect(() => {
    const element = calendar.current
    if (!open || !element || !element.showPopover) return
    element.showPopover()
    return () => {
      if (element.isConnected) element.hidePopover()
    }
  }, [open])

  useLayoutEffect(() => {
    const element = calendar.current
    const button = trigger.current
    if (!open || !element || !button || !element.showPopover) return

    function placeCalendar() {
      if (!element || !button) return
      const buttonRect = button.getBoundingClientRect()
      const width = Math.max(1, Math.min(450, buttonRect.width, window.innerWidth - 16))
      element.style.width = `${width}px`
      element.style.maxHeight = ''
      const height = element.getBoundingClientRect().height
      const left = Math.max(8, Math.min(buttonRect.left, window.innerWidth - width - 8))
      const below = buttonRect.bottom + 8
      const belowSpace = Math.max(0, window.innerHeight - below - 8)
      const aboveSpace = Math.max(0, buttonRect.top - 16)
      const useBelow = height <= belowSpace || belowSpace >= 220 || belowSpace >= aboveSpace
      const availableHeight = useBelow ? belowSpace : aboveSpace
      const top = useBelow ? below : Math.max(8, buttonRect.top - 8 - Math.min(height, aboveSpace))
      element.style.maxHeight = `${Math.max(1, availableHeight)}px`
      element.style.left = `${left}px`
      element.style.top = `${top}px`
    }

    placeCalendar()
    window.addEventListener('resize', placeCalendar)
    window.addEventListener('scroll', placeCalendar, true)
    return () => {
      window.removeEventListener('resize', placeCalendar)
      window.removeEventListener('scroll', placeCalendar, true)
    }
  }, [open, month, year])

  function toggle() {
    if (!open) {
      const date = dateParts(value || max || '')
      if (date) {
        setYear(date.year)
        setMonth(date.month)
      }
    }
    setOpen(!open)
  }

  function choose(day: number) {
    onChange(isoDate(year, month, day))
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <div
      ref={root}
      className={styles.fieldGroup}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          trigger.current?.focus()
        }
      }}
    >
      <label htmlFor={id}>
        {label}
        {optional && <span className={styles.optional}> (optional)</span>}
      </label>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-calendar`}
        disabled={disabled}
        onClick={toggle}
      >
        <span className={value ? undefined : styles.placeholder}>
          {selected
            ? `${months[selected.month].slice(0, 3)} ${selected.day}, ${selected.year}`
            : placeholder}
        </span>
        <CalendarDays size={20} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={calendar}
          id={`${id}-calendar`}
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()}`}
          className={styles.popover}
          popover="manual"
        >
          <div className={styles.selectRow}>
            <div className={styles.selectWrap}>
              <select
                aria-label="Month"
                value={month}
                onChange={(event) => setMonth(Number(event.target.value))}
              >
                {months.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
              <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />
            </div>
            <div className={styles.selectWrap}>
              <select
                aria-label="Year"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
              >
                {years.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <ChevronDown size={18} strokeWidth={2} aria-hidden="true" />
            </div>
          </div>
          <div className={styles.calendarGrid}>
            {weekdays.map((day) => (
              <span key={day} className={styles.weekday}>
                {day}
              </span>
            ))}
            {Array.from({ length: firstWeekday }, (_, index) => (
              <span key={`empty-${index}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = index + 1
              const date = isoDate(year, month, day)
              return (
                <button
                  key={day}
                  type="button"
                  className={styles.day}
                  aria-label={`${months[month]} ${day}, ${year}`}
                  aria-pressed={value === date}
                  disabled={(min !== undefined && date < min) || (max !== undefined && date > max)}
                  onClick={() => choose(day)}
                >
                  {day}
                </button>
              )
            })}
          </div>
          {optional && value && (
            <button
              type="button"
              className={styles.clear}
              onClick={() => {
                onChange('')
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              Clear date
            </button>
          )}
        </div>
      )}
    </div>
  )
}
