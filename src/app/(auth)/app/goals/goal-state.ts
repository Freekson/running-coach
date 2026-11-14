import type { GoalWithProgress } from '@/lib/goal-progress'
import type { GoalMutation, GoalMutationReceipt, GoalSnapshot } from '@/lib/goal-snapshot'

type ConfirmedGoal = { value: GoalWithProgress | null; receipt: GoalMutationReceipt }
export type GoalState = {
  received: GoalSnapshot
  base: GoalSnapshot
  confirmed: ReadonlyMap<string, ConfirmedGoal>
}

function snapshotParts(snapshot: string) {
  if (!/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(snapshot)) throw new Error('Invalid goal snapshot')
  const [, maximum, active] = snapshot.split(':')
  return { maximum: BigInt(maximum), active: new Set(active ? active.split(',') : []) }
}

/** Receipts are returned only after successful commits, so "completed" means committed here. */
export function seesGoalMutation(snapshot: string, transactionId: string) {
  const parts = snapshotParts(snapshot)
  return BigInt(transactionId) < parts.maximum && !parts.active.has(transactionId)
}

function includesSnapshot(
  left: ReturnType<typeof snapshotParts>,
  right: ReturnType<typeof snapshotParts>,
) {
  return (
    left.maximum >= right.maximum &&
    [...left.active].every((id) => BigInt(id) >= right.maximum || right.active.has(id))
  )
}

export function createGoalState(snapshot: GoalSnapshot): GoalState {
  return { received: snapshot, base: snapshot, confirmed: new Map() }
}

export function acceptGoalSnapshot(state: GoalState, incoming: GoalSnapshot): GoalState {
  if (incoming.ownerId !== state.base.ownerId) return createGoalState(incoming)
  const next = snapshotParts(incoming.snapshot),
    previous = snapshotParts(state.base.snapshot)
  const includesPrevious = includesSnapshot(next, previous)
  const sameVisibility = includesPrevious && includesSnapshot(previous, next)
  // The database clock orders reads with identical transaction visibility,
  // such as a calendar boundary without newly imported activities.
  if (
    !includesPrevious ||
    (sameVisibility && BigInt(incoming.observedAt) < BigInt(state.base.observedAt))
  )
    return { ...state, received: incoming }
  const confirmed = new Map(
    [...state.confirmed].filter(
      ([, change]) => !seesGoalMutation(incoming.snapshot, change.receipt.transactionId),
    ),
  )
  return { received: incoming, base: incoming, confirmed }
}

export function acceptGoalMutation(
  state: GoalState,
  id: string,
  result: GoalMutation<GoalWithProgress | null>,
): GoalState {
  const { receipt, value } = result
  if (
    receipt.ownerId !== state.base.ownerId ||
    seesGoalMutation(state.base.snapshot, receipt.transactionId)
  )
    return state
  const current = state.confirmed.get(id)
  if (
    current &&
    (current.receipt.transactionId === receipt.transactionId ||
      !seesGoalMutation(receipt.snapshot, current.receipt.transactionId))
  )
    return state
  const confirmed = new Map(state.confirmed)
  confirmed.set(id, { value, receipt })
  return { ...state, confirmed }
}

export function goalStateRecords(state: GoalState): GoalWithProgress[] {
  const existing = new Set(state.base.goals.map((goal) => goal.id))
  const created = [...state.confirmed.entries()]
    .reverse()
    .flatMap(([id, change]) => (!existing.has(id) && change.value ? [change.value] : []))
  return [
    ...created,
    ...state.base.goals.flatMap((goal) => {
      const change = state.confirmed.get(goal.id)
      return change ? (change.value ? [change.value] : []) : [goal]
    }),
  ]
}
