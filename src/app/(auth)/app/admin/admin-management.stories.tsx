import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { AdminManagement } from './admin-management'

const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
const invitations = (['pending', 'processing', 'used', 'revoked', 'expired'] as const).map(
  (status) => ({
    id: status,
    revision: 'a'.repeat(64),
    label: `${status[0].toUpperCase() + status.slice(1)} invitation`,
    createdAt,
    expiresAt: status === 'expired' ? createdAt : expiresAt,
    status,
  }),
)

const meta = {
  title: 'Admin/Invitation management',
  component: AdminManagement,
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
  args: {
    invitations,
    invitationPage: 1,
    invitationTotal: invitations.length,
    invitationCounts: { all: 5, pending: 1, processing: 1, used: 1, revoked: 1, expired: 1 },
    users: [
      { id: 'u1', email: 'admin@example.com', role: 'ADMIN', status: 'ACTIVE', createdAt },
      { id: 'u2', email: 'runner@example.com', role: 'USER', status: 'ACTIVE', createdAt },
      { id: 'u3', email: 'paused@example.com', role: 'USER', status: 'SUSPENDED', createdAt },
    ],
    userPage: 1,
    userTotal: 3,
  },
} satisfies Meta<typeof AdminManagement>

export default meta
type Story = StoryObj<typeof meta>

export const AllStatuses: Story = {}
export const RevokeConfirmation: Story = {
  play: ({ canvasElement }) => {
    canvasElement
      .querySelector<HTMLButtonElement>('[aria-label="Revoke invitation: Pending invitation"]')
      ?.click()
  },
}
export const RegenerateConfirmation: Story = {
  play: ({ canvasElement }) => {
    canvasElement
      .querySelector<HTMLButtonElement>('[aria-label="Regenerate invitation link"]')
      ?.click()
  },
}
export const ExpiredPending: Story = {
  args: {
    invitations: [
      ...invitations.slice(0, 4),
      {
        id: 'expired-pending',
        revision: 'a'.repeat(64),
        label: 'Pending link that passed its deadline',
        createdAt,
        expiresAt: createdAt,
        status: 'pending',
      },
    ],
  },
}
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
export const Empty: Story = {
  args: {
    invitations: [],
    users: [],
    invitationTotal: 0,
    userTotal: 0,
    invitationCounts: { all: 0, pending: 0, processing: 0, used: 0, revoked: 0, expired: 0 },
  },
}
export const EmptyFiltered: Story = {
  args: { invitations: [invitations[0]] },
  play: ({ canvasElement }) => {
    const usedFilter = [
      ...canvasElement.querySelectorAll<HTMLButtonElement>('[aria-pressed]'),
    ].find((button) => button.textContent?.startsWith('Used'))
    usedFilter?.click()
  },
}
