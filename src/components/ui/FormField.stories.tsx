import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { FormField } from './FormField'

const meta = {
  title: 'UI/FormField',
  component: FormField,
  args: {
    id: 'email',
    name: 'email',
    label: 'Email address',
    type: 'email',
    placeholder: 'runner@example.com',
  },
} satisfies Meta<typeof FormField>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const WithHint: Story = { args: { hint: 'Use the address from your invitation.' } }
export const Optional: Story = {
  args: { id: 'description', name: 'description', label: 'Description', optional: true },
}
export const Error: Story = { args: { error: 'Enter a valid email address.' } }
export const DuplicateEmail: Story = {
  args: {
    value: 'runner@example.com',
    readOnly: true,
    error: 'An account with this email already exists.',
  },
}
export const Disabled: Story = {
  args: { disabled: true, value: 'runner@example.com', readOnly: true },
}
export const Required: Story = { args: { required: true } }
export const Mobile: Story = {
  args: { label: 'Email address for your Running Coach invitation' },
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
