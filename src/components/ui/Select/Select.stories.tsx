import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { fn } from 'storybook/test'
import { Select, type SelectProps } from './index'

function Example(args: SelectProps<string>) {
  const [value, setValue] = useState(args.value)
  return (
    <Select
      {...args}
      value={value}
      onChange={(next) => {
        setValue(next)
        args.onChange(next)
      }}
    />
  )
}
const meta = {
  title: 'UI/Select',
  component: Select,
  render: (args) => <Example {...args} />,
  args: {
    id: 'sport',
    label: 'Sport',
    value: '',
    onChange: fn(),
    options: [
      { value: '', label: 'All sports' },
      { value: 'RUNNING', label: 'Running' },
      { value: 'CYCLING', label: 'Cycling' },
      { value: 'WALKING', label: 'Walking' },
    ],
  },
} satisfies Meta<typeof Select>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Disabled: Story = { args: { disabled: true } }
export const PageSize: Story = {
  args: {
    id: 'page-size',
    label: 'Per page',
    value: '10',
    options: [
      { value: '10', label: '10 / page' },
      { value: '25', label: '25 / page' },
      { value: '50', label: '50 / page' },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 150, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
export const PageSizeOpen: Story = {
  ...PageSize,
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('#page-size')?.click()
  },
}
export const Descriptions: Story = {
  args: {
    label: 'Training experience',
    value: 'BEGINNER',
    options: [
      { value: 'BEGINNER', label: 'Beginner', description: 'Starting a running routine' },
      { value: 'INTERMEDIATE', label: 'Intermediate', description: 'Training consistently' },
      { value: 'ADVANCED', label: 'Advanced', description: 'Structured training experience' },
    ],
  },
}
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
