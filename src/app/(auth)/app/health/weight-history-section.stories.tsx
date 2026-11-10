import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { MeasurementSystemProvider } from '../measurement-system-provider'
import { WeightHistorySection } from './weight-history-section'

const readings = [76.4, 76.8, 77.3, 77.5].map((valueKg, index) => ({
  id: `reading-${index}`,
  measuredAt: new Date(Date.now() - index * 5 * 86_400_000).toISOString(),
  measuredOn: null,
  createdAt: new Date(Date.now() - index * 5 * 86_400_000).toISOString(),
  valueKg,
}))

const meta = {
  title: 'Health/Weight history',
  component: WeightHistorySection,
  render: (args) => (
    <MeasurementSystemProvider initialSystem="METRIC">
      <WeightHistorySection {...args} />
    </MeasurementSystemProvider>
  ),
  args: {
    initialPeriod: '30D',
    initialWeights: readings.slice(0, 3),
    initialChartWeights: readings,
  },
} satisfies Meta<typeof WeightHistorySection>

export default meta
type Story = StoryObj<typeof meta>

export const WithHistory: Story = {}
export const LongHistory: Story = {
  args: {
    initialChartWeights: Array.from({ length: 90 }, (_, index) => ({
      id: `daily-${index}`,
      measuredAt: new Date(Date.now() - index * 86_400_000).toISOString(),
      measuredOn: null,
      createdAt: new Date(Date.now() - index * 86_400_000).toISOString(),
      valueKg: 85 + index * 0.04 + Math.sin(index / 4) * 0.5,
    })),
  },
}
export const EmptyHistory: Story = {
  args: { initialWeights: [], initialChartWeights: [] },
}
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
