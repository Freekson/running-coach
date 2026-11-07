import { EmptyState } from '@/components/ui/States'

export function PendingSection({ title, description }: { title: string; description: string }) {
  return (
    <section className="app-page">
      <h1>{title}</h1>
      <EmptyState title={`${title} is coming soon`} description={description} />
    </section>
  )
}
