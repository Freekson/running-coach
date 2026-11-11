import 'server-only'

import type { OwnerContext } from '@/server/authorization/ownership'

/** A stream owns its planning, provider pages, validation, writes and checkpoint shape. */
export type GarminStreamAdapter<Id extends string, Action extends string, State, Dependencies> = {
  streamId: Id
  execute: (
    owner: OwnerContext,
    options: { streamId: Id; action: Action; browserTimezone: string },
    dependencies: Dependencies,
  ) => Promise<State>
}

export function createGarminStreamCoordinator<
  Id extends string,
  Action extends string,
  State,
  Dependencies,
>(
  adapters: ReadonlyArray<GarminStreamAdapter<Id, Action, State, Dependencies>>,
  unavailable: () => Error,
) {
  const registry = new Map(adapters.map((adapter) => [adapter.streamId, adapter]))
  return {
    run(
      owner: OwnerContext,
      options: { streamId: Id; action: Action; browserTimezone: string },
      dependencies: Dependencies,
    ): Promise<State> {
      const adapter = registry.get(options.streamId)
      if (!adapter) throw unavailable()
      return adapter.execute(owner, options, dependencies)
    },
  }
}

export type GarminStreamStep<Checkpoint> = { checkpoint: Checkpoint; written: boolean }

/** The same bounded, checkpointed loop can process date batches or offset pages. */
export async function processGarminStreamWork<Checkpoint, Work>(options: {
  checkpoint: Checkpoint
  maxSteps: number
  next: (checkpoint: Checkpoint, index: number) => Work | null
  execute: (checkpoint: Checkpoint, work: Work) => Promise<GarminStreamStep<Checkpoint>>
  recover: (
    checkpoint: Checkpoint,
    work: Work,
    error: unknown,
  ) => GarminStreamStep<Checkpoint> | null
  save: (step: GarminStreamStep<Checkpoint>) => Promise<void>
  shouldStop: () => boolean
}): Promise<{ checkpoint: Checkpoint; processed: number; written: number }> {
  let checkpoint = options.checkpoint
  let processed = 0
  let written = 0
  for (let index = 0; index < options.maxSteps; index++) {
    if (options.shouldStop()) break
    const work = options.next(checkpoint, index)
    if (work === null) break
    let step: GarminStreamStep<Checkpoint>
    try {
      step = await options.execute(checkpoint, work)
    } catch (error) {
      const recovered = options.recover(checkpoint, work, error)
      if (!recovered) throw error
      step = recovered
    }
    await options.save(step)
    checkpoint = step.checkpoint
    processed++
    if (step.written) written++
  }
  return { checkpoint, processed, written }
}
