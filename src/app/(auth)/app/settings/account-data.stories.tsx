import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { AccountData } from './account-data'

const meta = {
  title: 'Athlete/Account data',
  component: AccountData,
  parameters: {
    docs: {
      description: {
        component:
          'Private account download and destructive confirmation. Open Delete account to review revocation, backup and recovery guidance. Confirmation is disabled until both acknowledgements are supplied.',
      },
    },
  },
} satisfies Meta<typeof AccountData>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Narrow: Story = { parameters: { viewport: { defaultViewport: 'mobile1' } } }
export const Confirmation: Story = {
  play: async ({ canvasElement }) => {
    const button = [...canvasElement.querySelectorAll('button')].find(
      (element) => element.textContent === 'Delete account',
    )
    button?.click()
  },
}
