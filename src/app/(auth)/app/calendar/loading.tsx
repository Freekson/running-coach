import { renderProtectedPage } from '../protected-page'
import { CalendarLoading } from './calendar-loading'

export default async function Loading() {
  return renderProtectedPage(<CalendarLoading />)
}
