import { Suspense, type ComponentProps } from 'react'
import { AppShellView } from './app-shell-view'
import { PlanReminderRegion } from './plan-reminders/plan-reminder-region'

export function AppShell(props: Omit<ComponentProps<typeof AppShellView>, 'reminders'>) {
  return (
    <AppShellView
      {...props}
      reminders={
        <Suspense fallback={null}>
          <PlanReminderRegion user={props.user} />
        </Suspense>
      }
    />
  )
}
