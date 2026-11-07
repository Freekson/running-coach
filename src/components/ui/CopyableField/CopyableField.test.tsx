import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CopyableField, copyValue } from '.'

it('renders the entire value in a labeled read-only field with an embedded copy action', () => {
  const value = `https://running.example/sign-up#invite=${'a'.repeat(180)}`
  const html = renderToStaticMarkup(<CopyableField id="link" label="Invite link" value={value} />)
  expect(html).toContain(`value="${value}"`)
  expect(html).toContain('readOnly=""')
  expect(html).toContain('aria-label="Copy invite link"')
  expect(html).toContain('lucide-copy')
  expect(html).toContain('aria-hidden="true"')
})

it('disables copy for empty values', () => {
  const html = renderToStaticMarkup(<CopyableField id="link" label="Invite link" value="" />)
  expect(html).toContain('disabled=""')
})

it('copies the complete value and reports clipboard failure', async () => {
  const value = `https://running.example/sign-up#invite=${'a'.repeat(180)}`
  const writeText = vi.fn().mockResolvedValue(undefined)
  expect(await copyValue(value, writeText)).toBe(true)
  expect(writeText).toHaveBeenCalledWith(value)
  expect(await copyValue(value, vi.fn().mockRejectedValue(new Error('blocked')))).toBe(false)
})
