import {
  workoutDefinitionSchema,
  type WorkoutDefinition,
  type WorkoutNode,
  type WorkoutStep,
  type WorkoutTarget,
  type WorkoutTermination,
} from '@/schemas/workout-definition.v1'

export type DraftStep = {
  id: string
  type: 'step'
  name: string
  ending: WorkoutTermination['type']
  durationSeconds: string
  distanceMeters: string
  target: WorkoutTarget['type']
  minSecondsPerKm: string
  maxSecondsPerKm: string
  minBpm: string
  maxBpm: string
}
export type DraftNode =
  DraftStep | { id: string; type: 'repeat'; count: string; steps: DraftNode[] }
export type WorkoutDraft = {
  name: string
  sport: WorkoutDefinition['sport']
  steps: DraftNode[]
}

export function newStep(id: string, name = 'Work'): DraftStep {
  return {
    id,
    type: 'step',
    name,
    ending: 'time',
    durationSeconds: '300',
    distanceMeters: '1000',
    target: 'free',
    minSecondsPerKm: '300',
    maxSecondsPerKm: '330',
    minBpm: '130',
    maxBpm: '150',
  }
}

export function draftFromDefinition(input: unknown): WorkoutDraft {
  const definition = workoutDefinitionSchema.parse(input)
  function nodes(steps: WorkoutNode[], prefix: string): DraftNode[] {
    return steps.map((node, index) => {
      const id = `${prefix}-${index}`
      if (node.type === 'repeat')
        return { id, type: 'repeat', count: String(node.count), steps: nodes(node.steps, id) }
      return {
        ...newStep(id, node.name ?? ''),
        ending: node.termination.type,
        ...(node.termination.type === 'time'
          ? { durationSeconds: String(node.termination.durationSeconds) }
          : node.termination.type === 'distance'
            ? { distanceMeters: String(node.termination.distanceMeters) }
            : {}),
        target: node.target.type,
        ...(node.target.type === 'pace'
          ? {
              minSecondsPerKm: String(node.target.minSecondsPerKm),
              maxSecondsPerKm: String(node.target.maxSecondsPerKm),
            }
          : node.target.type === 'heartRate'
            ? { minBpm: String(node.target.minBpm), maxBpm: String(node.target.maxBpm) }
            : {}),
      }
    })
  }
  return {
    name: definition.name,
    sport: definition.sport,
    steps: nodes(definition.steps, 'initial'),
  }
}

const numeric = (value: string) => (value.trim() === '' ? NaN : Number(value))

export function validateDraft(draft: WorkoutDraft) {
  function nodes(steps: DraftNode[]): WorkoutNode[] {
    return steps.map((node): WorkoutNode => {
      if (node.type === 'repeat')
        return { type: 'repeat', count: numeric(node.count), steps: nodes(node.steps) }
      const termination: WorkoutTermination =
        node.ending === 'time'
          ? { type: 'time', durationSeconds: numeric(node.durationSeconds) }
          : node.ending === 'distance'
            ? { type: 'distance', distanceMeters: numeric(node.distanceMeters) }
            : { type: 'lap' }
      const target: WorkoutTarget =
        node.target === 'pace'
          ? {
              type: 'pace',
              minSecondsPerKm: numeric(node.minSecondsPerKm),
              maxSecondsPerKm: numeric(node.maxSecondsPerKm),
            }
          : node.target === 'heartRate'
            ? { type: 'heartRate', minBpm: numeric(node.minBpm), maxBpm: numeric(node.maxBpm) }
            : { type: 'free' }
      const step: WorkoutStep = { type: 'step', termination, target }
      if (node.name !== '') step.name = node.name
      return step
    })
  }
  return workoutDefinitionSchema.safeParse({
    schemaVersion: 1,
    ...draft,
    steps: nodes(draft.steps),
  })
}
