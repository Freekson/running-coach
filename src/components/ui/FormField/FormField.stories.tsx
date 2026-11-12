import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { Button } from '../Button'
import { DateField } from '../DateField'
import { Select } from '../Select'
import { FormField } from '.'

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

function ControlsExample() {
  const [date, setDate] = useState('')
  const [sport, setSport] = useState('')
  return (
    <div
      style={{
        display: 'grid',
        gap: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
        alignItems: 'end',
        maxWidth: 900,
      }}
    >
      <FormField id="control-search" label="Search activities" placeholder="Search by name…" />
      <Select
        id="control-sport"
        label="Sport"
        value={sport}
        onChange={setSport}
        options={[
          { value: '', label: 'All sports' },
          { value: 'RUNNING', label: 'Running' },
        ]}
      />
      <DateField id="control-date" label="From" value={date} onChange={setDate} />
      <Button>Apply filters</Button>
    </div>
  )
}
export const ConsistentControls: Story = { render: () => <ControlsExample /> }
export const MobileControls: Story = {
  ...ConsistentControls,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
