import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { CopyableField } from '.'

const meta = {
  title: 'UI/CopyableField',
  component: CopyableField,
  args: {
    id: 'invite-url',
    label: 'Invitation link',
    value: 'https://running.example/sign-up#invite=example-token',
  },
} satisfies Meta<typeof CopyableField>
export default meta
type Story = StoryObj<typeof meta>

async function showCopyResult(
  canvasElement: HTMLElement,
  writeText: (value: string) => Promise<void>,
) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  try {
    canvasElement.querySelector('button')?.click()
    await Promise.resolve()
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
}

export const Default: Story = {}
export const Empty: Story = { args: { value: '' } }
export const Disabled: Story = { args: { disabled: true } }
export const LongUrl: Story = {
  args: { value: `https://running.example/sign-up#invite=${'a'.repeat(180)}` },
}
export const NarrowViewport: Story = {
  ...LongUrl,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
export const KeyboardCopy: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('button')?.focus()
  },
}
export const Copied: Story = {
  play: async ({ canvasElement }) => showCopyResult(canvasElement, async () => {}),
}
export const Copying: Story = {
  play: async ({ canvasElement }) =>
    showCopyResult(canvasElement, () => new Promise<void>(() => {})),
}
export const ClipboardFailure: Story = {
  play: async ({ canvasElement }) =>
    showCopyResult(canvasElement, async () => {
      throw new Error('blocked')
    }),
}
