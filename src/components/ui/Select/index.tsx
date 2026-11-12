'use client'

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import styles from './Select.module.scss'

export type SelectOption<Value extends string> = {
  value: Value
  label: string
  description?: string
}
export type SelectProps<Value extends string> = {
  id: string
  label: string
  value: Value
  options: readonly SelectOption<Value>[]
  onChange: (value: Value) => void
  disabled?: boolean
}

export function Select<Value extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
}: SelectProps<Value>) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )
  useLayoutEffect(() => {
    const list = listbox.current
    const button = trigger.current
    if (!open || !list || !button || !list.showPopover) return
    list.showPopover()
    const position = () => {
      const anchor = button.getBoundingClientRect()
      const width = Math.max(1, Math.min(anchor.width, window.innerWidth - 16))
      const below = window.innerHeight - anchor.bottom - 16
      const above = anchor.top - 16
      const useBelow = below >= 240 || below >= above
      list.style.width = `${width}px`
      list.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`
      list.style.maxHeight = `${Math.max(1, Math.min(320, useBelow ? below : above))}px`
      list.style.top = `${useBelow ? anchor.bottom + 8 : Math.max(8, anchor.top - 8 - list.getBoundingClientRect().height)}px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      if (list.isConnected) list.hidePopover()
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    buttons.current[selectedIndex]?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, selectedIndex])

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = buttons.current.findIndex((button) => button === document.activeElement)
    let next: number
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % options.length
        break
      case 'ArrowUp':
        next = (index + options.length - 1) % options.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = options.length - 1
        break
      case 'Escape':
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
        return
      default:
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
        next = options.findIndex(
          (option, position) =>
            position > index && option.label.toLowerCase().startsWith(event.key.toLowerCase()),
        )
        if (next < 0)
          next = options.findIndex((option) =>
            option.label.toLowerCase().startsWith(event.key.toLowerCase()),
          )
        if (next < 0) return
    }
    event.preventDefault()
    buttons.current[next]?.focus()
    buttons.current[next]?.scrollIntoView?.({ block: 'nearest' })
  }

  return (
    <div
      ref={root}
      className={styles.select}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <span id={`${id}-label`} className={styles.label}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={styles.trigger}
        disabled={disabled || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}`}
        aria-controls={open ? `${id}-options` : undefined}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span>{options[selectedIndex]?.label ?? value}</span>
        <ChevronDown size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
      </button>
      {open && (
        <div
          ref={listbox}
          popover="manual"
          id={`${id}-options`}
          role="listbox"
          aria-labelledby={`${id}-label`}
          className={styles.options}
          onKeyDown={keyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              tabIndex={index === selectedIndex ? 0 : -1}
              ref={(element) => {
                buttons.current[index] = element
              }}
              aria-selected={option.value === value}
              className={styles.option}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              <strong>{option.label}</strong>
              {option.description && <span>{option.description}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
