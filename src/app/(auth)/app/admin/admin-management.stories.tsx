import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { ToastProvider } from '@/components/ui/Toast'
import { AdminManagement } from './admin-management'

const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
const invitations = (['pending', 'processing', 'used', 'revoked', 'expired'] as const).map(
  (status) => ({
    id: status,
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
    users: [
      { id: 'u1', email: 'admin@example.com', role: 'ADMIN', status: 'ACTIVE', createdAt },
      { id: 'u2', email: 'runner@example.com', role: 'USER', status: 'ACTIVE', createdAt },
      { id: 'u3', email: 'paused@example.com', role: 'USER', status: 'SUSPENDED', createdAt },
    ],
  },
} satisfies Meta<typeof AdminManagement>

export default meta
type Story = StoryObj<typeof meta>

export const AllStatuses: Story = {}
export const ExpiredPending: Story = {
  args: {
    invitations: [
      ...invitations,
      {
        id: 'expired-pending',
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
export const Empty: Story = { args: { invitations: [], users: [] } }
export const EmptyFiltered: Story = {
  args: { invitations: [invitations[0]] },
  play: ({ canvasElement }) => {
    const usedFilter = [
      ...canvasElement.querySelectorAll<HTMLButtonElement>('[aria-pressed]'),
    ].find((button) => button.textContent?.startsWith('Used'))
    usedFilter?.click()
  },
}
