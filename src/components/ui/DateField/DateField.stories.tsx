import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { FormField } from '../FormField'
import { DateField, type DateFieldProps } from '.'

function Example(args: DateFieldProps) {
  const [value, setValue] = useState(args.value)
  return <DateField {...args} value={value} onChange={setValue} />
}

const meta = {
  title: 'UI/DateField',
  component: DateField,
  render: Example,
  args: {
    id: 'birth-date',
    label: 'Date of birth',
    value: '',
    onChange: () => {},
    max: '2026-11-07',
    optional: true,
  },
} satisfies Meta<typeof DateField>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}
export const Selected: Story = {
  args: { value: '2000-01-15' },
}
export const Disabled: Story = {
  args: { value: '2000-01-15', disabled: true },
}
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}

function InDialogExample() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('2026-11-07')
  return (
    <>
      <Button onClick={() => setOpen(true)}>Add weight</Button>
      <Dialog
        open={open}
        title="Add weight reading"
        onClose={() => setOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button>Save reading</Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 20 }}>
          <FormField id="example-weight" label="Weight" type="number" placeholder="Enter weight" />
          <DateField
            id="measurement-date"
            label="Measurement date"
            value={value}
            onChange={setValue}
            max="2026-11-07"
          />
        </div>
      </Dialog>
    </>
  )
}

export const InsideDialog: Story = {
  render: () => <InDialogExample />,
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button')?.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    canvasElement.querySelector<HTMLButtonElement>('#measurement-date')?.click()
  },
}
