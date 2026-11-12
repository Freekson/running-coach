'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import type { UserRole } from '@prisma/client'
import { Dumbbell, Heart, LayoutDashboard, Settings, Shield } from 'lucide-react'
import { useNavigationGuard } from './navigation-guard'
import styles from './app-shell.module.scss'

const sections = [
  { label: 'Dashboard', href: '/app/dashboard', icon: LayoutDashboard },
  { label: 'Training', href: '/app/training', icon: Dumbbell },
  { label: 'Health', href: '/app/health', icon: Heart },
  { label: 'Settings', href: '/app/settings', icon: Settings },
] as const

export function AppNavigation({ role }: { role: UserRole }) {
  const pathname = usePathname()
  const router = useRouter()
  const { requestLeave } = useNavigationGuard()
  const links =
    role === 'ADMIN'
      ? [...sections, { label: 'Admin', href: '/app/admin', icon: Shield }]
      : sections

  return (
    <nav className={styles.navigation} aria-label="App navigation">
      {links.map(({ label, href, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={[styles.navLink, href === '/app/admin' && styles.adminLink]
            .filter(Boolean)
            .join(' ')}
          aria-current={pathname === href || pathname.startsWith(`${href}/`) ? 'page' : undefined}
          onNavigate={(event) => {
            if (pathname !== href && requestLeave(() => router.push(href))) event.preventDefault()
          }}
        >
          <Icon size={20} strokeWidth={2} aria-hidden="true" focusable="false" />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  )
}
