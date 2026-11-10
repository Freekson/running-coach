import { renderToStaticMarkup } from 'react-dom/server'
import { HeartPulse } from 'lucide-react'
import { expect, it } from 'vitest'
import { SectionHeading } from './index'

it('renders a decorative icon, heading level, and optional subtitle', () => {
  const withSubtitle = renderToStaticMarkup(
    <SectionHeading
      icon={HeartPulse}
      id="heart-heading"
      title="Resting heart rate"
      subtitle="Daily Garmin measurements"
    />,
  )
  expect(withSubtitle).toContain('<h2 id="heart-heading"')
  expect(withSubtitle).toContain('Daily Garmin measurements')
  expect(withSubtitle).toContain('aria-hidden="true"')

  const titleOnly = renderToStaticMarkup(
    <SectionHeading icon={HeartPulse} title="Sleep trends" level={3} />,
  )
  expect(titleOnly).toContain('<h3')
  expect(titleOnly).not.toMatch(/<p(?:\s|>)/)

  const inline = renderToStaticMarkup(
    <SectionHeading icon={HeartPulse} title="Sync details" subtitle="Last completed" inline />,
  )
  expect(inline).toContain('role="heading" aria-level="2"')
  expect(inline).not.toContain('<div')
})
