import type { ReactNode } from 'react'
import type { CurrentUser } from '@/server/auth/current-user'
import { AdminBadge } from '@/components/ui/AdminBadge'
import { SignOutButton } from '../sign-out-button'
import { AppNavigation } from './navigation'
import styles from './app-shell.module.scss'

export function AppShell({ children, user }: { children: ReactNode; user: CurrentUser }) {
  return (
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
          <p className={styles.identity}>{user.email ?? `Account ${user.id.slice(0, 8)}`}</p>
          <p className={styles.role}>{user.role === 'ADMIN' ? <AdminBadge /> : 'User'}</p>
          <SignOutButton />
        </div>
      </aside>
      <div className={styles.content}>{children}</div>
    </div>
  )
}
