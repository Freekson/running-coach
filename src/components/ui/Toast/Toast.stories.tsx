'use client'

import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { Button } from '../Button'
import { ToastProvider, ToastViewport, useToast, type ToastMessage } from '.'

function Example({ initial }: { initial: ToastMessage[] }) {
  const [toasts, setToasts] = useState(initial)
  return (
    <ToastViewport
      toasts={toasts}
      onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))}
    />
  )
}

function TriggerExample() {
  const toast = useToast()
  return <Button onClick={() => toast('success', 'Training plan saved.')}>Show toast</Button>
}

function InviteFeedbackExample() {
  const toast = useToast()
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button onClick={() => toast('success', 'Invite link copied.', 'invite-action')}>
        Link copied
      </Button>
      <Button
        variant="secondary"
        onClick={() => toast('success', 'Invite revoked.', 'invite-action')}
      >
        Invite revoked
      </Button>
    </div>
  )
}

const meta = {
  title: 'UI/Toast',
  component: ToastViewport,
  args: { toasts: [], onDismiss: () => {} },
} satisfies Meta<typeof ToastViewport>
export default meta
type Story = StoryObj<typeof meta>

export const Success: Story = {
  render: () => <Example initial={[{ id: 1, tone: 'success', message: 'Training plan saved.' }]} />,
}
export const Error: Story = {
  render: () => (
    <Example
      initial={[{ id: 1, tone: 'error', message: 'Could not save your changes. Try again.' }]}
    />
  ),
}
export const Warning: Story = {
  render: () => (
    <Example initial={[{ id: 1, tone: 'warning', message: 'This invitation expires soon.' }]} />
  ),
}
export const Info: Story = {
  render: () => (
    <Example initial={[{ id: 1, tone: 'info', message: 'Your plan is ready to review.' }]} />
  ),
}
export const Stacked: Story = {
  render: () => (
    <Example
      initial={[
        { id: 1, tone: 'success', message: 'Link copied.' },
        { id: 2, tone: 'error', message: 'Connection lost. Retry the request.' },
        { id: 3, tone: 'warning', message: 'Your session will expire soon.' },
      ]}
    />
  ),
}
export const KeyboardDismiss: Story = {
  render: () => (
    <Example
      initial={[
        { id: 1, tone: 'success', message: 'Focus the dismiss button and press Enter or Space.' },
      ]}
    />
  ),
}
export const NarrowViewport: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  render: () => (
    <Example
      initial={[
        {
          id: 1,
          tone: 'error',
          message: 'A longer notification remains readable on a narrow screen.',
        },
      ]}
    />
  ),
}
export const Transient: Story = {
  render: () => (
    <ToastProvider>
      <TriggerExample />
    </ToastProvider>
  ),
}

export const ReplacedFeedback: Story = {
  render: () => (
    <ToastProvider>
      <InviteFeedbackExample />
    </ToastProvider>
  ),
}
