import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { Ban, CircleCheck } from 'lucide-react'
import { Button } from './Button'
import { ConfirmDialog, Dialog } from './Dialog'

function DialogExample({
  destructive = false,
  loading = false,
  success = false,
}: {
  destructive?: boolean
  loading?: boolean
  success?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(loading)
  return (
    <>
      <Button
        onClick={() => {
          setPending(loading)
          setOpen(true)
        }}
      >
        Open dialog
      </Button>
      {destructive ? (
        <ConfirmDialog
          open={open}
          title="Revoke invitation?"
          description="This invitation link will stop working immediately. This action cannot be undone."
          icon={<Ban size={20} strokeWidth={2} aria-hidden="true" focusable="false" />}
          iconTone="error"
          confirmText="Revoke invitation"
          variant="destructive"
          pending={pending}
          onClose={() => setOpen(false)}
          onConfirm={() => {
            setPending(false)
            setOpen(false)
          }}
        />
      ) : (
        <Dialog
          open={open}
          title={success ? 'Invitation regenerated' : 'Dialog title'}
          description={
            success
              ? 'Your new link is ready. The previous link is no longer valid.'
              : 'A reusable dialog with focus and keyboard support.'
          }
          icon={
            success ? (
              <CircleCheck size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
            ) : undefined
          }
          iconTone={success ? 'success' : 'neutral'}
          size={success ? 'wide' : 'default'}
          pending={pending}
          onClose={() => setOpen(false)}
          actions={
            <Button onClick={() => setOpen(false)} disabled={pending}>
              Done
            </Button>
          }
        >
          <p>
            {success
              ? 'Copy this link now. Closing this dialog clears it.'
              : 'Dialog content can contain forms and other controls.'}
          </p>
        </Dialog>
      )}
    </>
  )
}
const meta = { title: 'UI/Dialog', component: DialogExample } satisfies Meta<typeof DialogExample>
export default meta
type Story = StoryObj<typeof meta>
export const Ordinary: Story = {}
export const Destructive: Story = { args: { destructive: true } }
export const Success: Story = { args: { success: true } }
export const Loading: Story = { args: { destructive: true, loading: true } }
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } }
