import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ArrowRight, ArrowUpRight, Plus, X } from 'lucide-react'
import { Button, ButtonLink } from '.'

const meta = {
  title: 'UI/Button',
  component: Button,
  args: { children: 'Save plan' },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}
export const Secondary: Story = { args: { variant: 'secondary', children: 'Cancel' } }
export const Compact: Story = { args: { size: 'compact', children: 'Add' } }
export const WithLeadingIcon: Story = {
  render: () => (
    <Button>
      <Plus size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
      Add workout
    </Button>
  ),
}
export const WithTrailingIcon: Story = {
  render: () => (
    <ButtonLink href="/status">
      Check status
      <ArrowRight size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
    </ButtonLink>
  ),
}
export const IconOnly: Story = {
  render: () => (
    <Button variant="secondary" size="compact" aria-label="Close panel">
      <X size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
    </Button>
  ),
}
export const Disabled: Story = { args: { disabled: true } }
export const Loading: Story = { args: { loading: true, children: 'Saving…' } }
export const LongLabelOnMobile: Story = {
  args: { children: 'Review the planned workout for next week' },
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}

function ClickCounter() {
  const [count, setCount] = useState(0)
  return <Button onClick={() => setCount((value) => value + 1)}>Clicked: {count}</Button>
}

export const Interactive: Story = { render: () => <ClickCounter /> }
export const Navigation: Story = {
  render: () => <ButtonLink href="/status">Check status</ButtonLink>,
}
export const DisabledNavigation: Story = {
  render: () => (
    <ButtonLink href="/status" disabled>
      Check status
    </ButtonLink>
  ),
}
export const DisabledIconNavigation: Story = {
  render: () => (
    <div>
      <span id="status-link-label">Status page</span>{' '}
      <ButtonLink href="/status" disabled aria-labelledby="status-link-label">
        <ArrowUpRight size={18} strokeWidth={2} aria-hidden="true" focusable="false" />
      </ButtonLink>
    </div>
  ),
}
