import { AccountUnavailableError, getCurrentUser } from '@/server/auth/current-user'
import { getOwnerContext } from '@/server/authorization/ownership'
import { AccountBusyError, accountDeletionSchema, deleteAccount } from '@/server/account/deletion'

const privateHeaders = { 'Cache-Control': 'private, no-store' }

export async function DELETE(request: Request) {
  try {
    const user = await getCurrentUser()
    if (!user) return new Response(null, { status: 401, headers: privateHeaders })
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return new Response(null, { status: 403, headers: privateHeaders })
    const input = accountDeletionSchema.safeParse(await request.json().catch(() => null))
    if (!input.success)
      return Response.json(
        { error: 'Confirm deletion and provider access revocation' },
        { status: 400, headers: privateHeaders },
      )
    await deleteAccount(getOwnerContext(user), input.data)
    return new Response(null, { status: 204, headers: privateHeaders })
  } catch (error) {
    const status =
      error instanceof AccountUnavailableError ? 403 : error instanceof AccountBusyError ? 409 : 503
    return Response.json(
      {
        error:
          status === 409
            ? 'Wait for current sync or publication to finish, then retry.'
            : 'Account deletion unavailable',
      },
      { status, headers: privateHeaders },
    )
  }
}
