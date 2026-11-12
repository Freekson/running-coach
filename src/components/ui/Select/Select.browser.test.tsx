// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Select } from './index'

let host: HTMLDivElement
let root: Root
const change = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  change.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
function render(disabled = false) {
  act(() =>
    root.render(
      <Select
        id="sort"
        label="Sort by"
        value="newest"
        disabled={disabled}
        onChange={change}
        options={[
          { value: 'newest', label: 'Newest first' },
          { value: 'oldest', label: 'Oldest first' },
          { value: 'distance', label: 'Longest distance' },
        ]}
      />,
    ),
  )
}
it('opens on an arrow key, navigates options, selects and restores trigger focus', () => {
  render()
  const trigger = host.querySelector('button')!
  act(() =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  )
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const options = host.querySelectorAll<HTMLButtonElement>('[role="option"]')
  expect(document.activeElement).toBe(options[0])
  act(() => options[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(document.activeElement).toBe(options[2])
  act(() => options[2].click())
  expect(change).toHaveBeenCalledWith('distance')
  expect(host.querySelector('[role="listbox"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
it('closes with Escape or an outside press without selecting a value', () => {
  render()
  act(() => host.querySelector('button')!.click())
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  )
  expect(host.querySelector('[role="listbox"]')).toBeNull()
  act(() => host.querySelector('button')!.click())
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  expect(host.querySelector('[role="listbox"]')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})
it('keeps a disabled selector inert', () => {
  render(true)
  act(() => host.querySelector('button')!.click())
  expect(host.querySelector('[role="listbox"]')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})
