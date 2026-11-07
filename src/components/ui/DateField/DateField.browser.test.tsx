// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DateField } from '.'

const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

afterEach(() => {
  act(() => root.render(null))
  host.replaceChildren()
})

it('uses the same calendar for optional dates and prevents future selection', () => {
  const onChange = vi.fn()
  act(() =>
    root.render(
      <DateField
        id="date"
        label="Date of birth"
        value=""
        max="2026-11-07"
        optional
        onChange={onChange}
      />,
    ),
  )
  act(() => host.querySelector<HTMLButtonElement>('#date')!.click())
  const calendar = host.querySelector<HTMLElement>('#date-calendar')!
  expect(
    calendar.querySelector<HTMLButtonElement>('button[aria-label="November 8, 2026"]')!.disabled,
  ).toBe(true)
  act(() =>
    calendar.querySelector<HTMLButtonElement>('button[aria-label="November 5, 2026"]')!.click(),
  )
  expect(onChange).toHaveBeenCalledWith('2026-11-05')
  expect(host.querySelector('#date-calendar')).toBeNull()
})

it('closes on Escape and restores focus to the trigger', () => {
  act(() =>
    root.render(
      <DateField id="date" label="Measurement date" value="2026-11-05" onChange={() => {}} />,
    ),
  )
  const trigger = host.querySelector<HTMLButtonElement>('#date')!
  act(() => trigger.click())
  act(() =>
    host
      .querySelector<HTMLElement>('#date-calendar')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(host.querySelector('#date-calendar')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('supports month and year selection and clearing an optional date', () => {
  const onChange = vi.fn()
  act(() =>
    root.render(
      <DateField
        id="date"
        label="Date of birth"
        value="2026-01-15"
        max="2026-11-07"
        optional
        onChange={onChange}
      />,
    ),
  )
  act(() => host.querySelector<HTMLButtonElement>('#date')!.click())
  const month = host.querySelector<HTMLSelectElement>('select[aria-label="Month"]')!
  const year = host.querySelector<HTMLSelectElement>('select[aria-label="Year"]')!
  act(() => {
    month.value = '1'
    month.dispatchEvent(new Event('change', { bubbles: true }))
    year.value = '2000'
    year.dispatchEvent(new Event('change', { bubbles: true }))
  })
  act(() =>
    host.querySelector<HTMLButtonElement>('button[aria-label="February 29, 2000"]')!.click(),
  )
  expect(onChange).toHaveBeenCalledWith('2000-02-29')

  act(() =>
    root.render(
      <DateField
        id="date"
        label="Date of birth"
        value="2000-02-29"
        max="2026-11-07"
        optional
        onChange={onChange}
      />,
    ),
  )
  act(() => host.querySelector<HTMLButtonElement>('#date')!.click())
  act(() =>
    [...host.querySelectorAll<HTMLButtonElement>('#date-calendar button')]
      .find((button) => button.textContent === 'Clear date')!
      .click(),
  )
  expect(onChange).toHaveBeenLastCalledWith('')
})

it('opens the calendar below its field even when it extends beyond the dialog', () => {
  const showDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'showPopover')
  const hideDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidePopover')
  const showPopover = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value: showPopover,
  })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value: vi.fn(),
  })
  const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.tagName === 'DIALOG') return new DOMRect(200, 150, 600, 550)
    if (this.id === 'date') return new DOMRect(230, 490, 540, 50)
    if (this.id === 'date-calendar') return new DOMRect(0, 0, 450, 380)
    return new DOMRect()
  })
  const viewportHeight = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000)

  try {
    act(() =>
      root.render(
        <dialog open>
          <DateField id="date" label="Measurement date" value="2026-11-05" onChange={() => {}} />
        </dialog>,
      ),
    )
    act(() => host.querySelector<HTMLButtonElement>('#date')!.click())
    const calendar = host.querySelector<HTMLElement>('#date-calendar')!
    expect(calendar.getAttribute('popover')).toBe('manual')
    expect(showPopover).toHaveBeenCalledOnce()
    expect(calendar.style.width).toBe('450px')
    expect(calendar.style.left).toBe('230px')
    expect(calendar.style.top).toBe('548px')
    expect(Number.parseInt(calendar.style.top) + 380).toBeGreaterThan(700)
    expect(Number.parseInt(calendar.style.top) + 380).toBeLessThan(1000)

    act(() => host.querySelector('dialog')!.dispatchEvent(new Event('close')))
    expect(host.querySelector('#date-calendar')).toBeNull()
  } finally {
    act(() => root.render(null))
    rect.mockRestore()
    viewportHeight.mockRestore()
    if (showDescriptor) Object.defineProperty(HTMLElement.prototype, 'showPopover', showDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
    if (hideDescriptor) Object.defineProperty(HTMLElement.prototype, 'hidePopover', hideDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
  }
})
