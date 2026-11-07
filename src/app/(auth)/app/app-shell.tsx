import type { ReactNode } from 'react'
import type { CurrentUser } from '@/server/auth/current-user'
import { SignOutButton } from '../sign-out-button'
import { AppNavigation } from './navigation'
import { MeasurementSystemProvider } from './measurement-system-provider'
import { NavigationGuardProvider } from './navigation-guard'
import type { MeasurementSystem } from '@/lib/measurement-system'
import styles from './app-shell.module.scss'

export function AppShell({
  children,
  user,
  measurementSystem,
}: {
  children: ReactNode
  user: CurrentUser
  measurementSystem: MeasurementSystem
}) {
  const identity =
    user.displayName?.trim() || user.name?.trim() || user.email || `Account ${user.id.slice(0, 8)}`
  const initial = Array.from(identity)[0]?.toLocaleUpperCase() ?? '?'
  return (
    <NavigationGuardProvider>
      <div className={styles.shell} data-app-shell>
        <aside className={styles.sidebar} aria-label="App sidebar">
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              ↗
            </span>
            <span>Running Coach</span>
          </div>
          <AppNavigation role={user.role} />
          <div className={styles.account}>
            <p className={styles.accountLabel}>Signed in as</p>
            <div className={styles.accountIdentity}>
              <span className={styles.avatar} aria-hidden="true">
                {initial}
              </span>
              <p className={styles.identity} title={identity}>
                {identity}
              </p>
            </div>
            <div className={styles.signOut}>
              <SignOutButton />
            </div>
          </div>
        </aside>
        <div className={styles.content}>
          <MeasurementSystemProvider key={measurementSystem} initialSystem={measurementSystem}>
            {children}
          </MeasurementSystemProvider>
        </div>
      </div>
    </NavigationGuardProvider>
  )
}
