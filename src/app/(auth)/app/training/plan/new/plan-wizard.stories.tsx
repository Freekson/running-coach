import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { PlanWizard, type PlanWizardProps } from './plan-wizard'
import { PlanReview } from './plan-review'
import { refreshChoice, refreshPreview } from '../refresh/plan-refresh.fixtures'
import {
  wizardArtifact,
  wizardGoal,
  wizardOwner,
  wizardPreview,
  wizardSetup,
} from './plan-wizard.fixtures'

const args: PlanWizardProps = {
  ownerId: `storybook-${wizardOwner}`,
  goals: [wizardGoal],
  onOpen: async () => ({ success: true, value: wizardSetup }),
  onExport: async () => ({ success: true, value: wizardArtifact }),
  onSchedule: async (input) => ({
    success: true,
    value: { version: input.expectedVersion + 1, constraints: input.constraints },
  }),
  onCreateGoal: async () => wizardGoal,
  onPreview: async () => ({ success: true, value: wizardPreview }),
  onApprove: async () => ({
    success: true,
    value: { approved: true, planId: 'story', revisionId: 'story', revisionNumber: 1 },
  }),
}
const meta = {
  title: 'Training/Plan creation',
  component: PlanWizard,
  args,
} satisfies Meta<typeof PlanWizard>
export default meta
type Story = StoryObj<typeof meta>
export const GuidedFlow: Story = {}
export const NoGoals: Story = { args: { ownerId: 'storybook-no-goals', goals: [] } }
export const RefreshFlow: Story = {
  args: {
    ownerId: 'storybook-refresh',
    refresh: refreshChoice,
    onPreview: async () => ({ success: true, value: refreshPreview }),
  },
}
export const ChangedGoalDate: Story = {
  args: {
    ownerId: 'storybook-changed-goal',
    refresh: refreshChoice,
    onOpen: async () => ({
      success: false,
      error:
        'The goal date changed since this plan was approved. Create a new training plan for the updated goal; your approved revisions are preserved.',
    }),
  },
}
export const RefreshReview: Story = {
  render: () => (
    <PlanReview
      preview={refreshPreview.preview}
      timezone="Asia/Tokyo"
      acknowledged={[]}
      onAcknowledge={() => {}}
      disabled={false}
    />
  ),
}
export const NarrowRefreshReview: Story = {
  ...RefreshReview,
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
export const ServiceFailure: Story = {
  args: {
    ownerId: 'storybook-unavailable',
    onOpen: async () => ({
      success: false,
      error: 'Your draft could not be opened. Please try again.',
    }),
  },
}
export const Review: Story = {
  render: () => (
    <PlanReview
      preview={wizardPreview.preview}
      timezone="Asia/Tokyo"
      acknowledged={[]}
      onAcknowledge={() => {}}
      disabled={false}
    />
  ),
}
export const NarrowReview: Story = {
  ...Review,
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: '100%' }}>
        <Story />
      </div>
    ),
  ],
}
