import { Shield } from 'lucide-react'
import { Badge } from '../Badge'

export function AdminBadge() {
  return (
    <Badge className="badge--admin">
      <Shield size={16} strokeWidth={2} aria-hidden="true" focusable="false" />
      ADMIN
    </Badge>
  )
}
