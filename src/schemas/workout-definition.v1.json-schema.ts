import { z } from 'zod'
import { workoutDefinitionSchema } from './workout-definition.v1'

// Standard JSON Schema cannot compare sibling numeric fields. Zod remains the
// authority for ordering pace/heart-rate ranges before saving or publishing.
export const workoutDefinitionJsonSchema = {
  ...z.toJSONSchema(workoutDefinitionSchema, { target: 'draft-2020-12', reused: 'ref' }),
  title: 'WorkoutDefinition v1',
  $comment:
    'Also validate with workoutDefinitionSchema: minSecondsPerKm <= maxSecondsPerKm and minBpm <= maxBpm.',
}
