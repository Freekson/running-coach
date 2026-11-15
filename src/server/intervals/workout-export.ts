import 'server-only'

import { Decoder, Stream, type WorkoutStepMesg } from '@garmin/fitsdk'
import {
  workoutDefinitionSchema,
  type WorkoutNode,
  type WorkoutStep,
} from '@/schemas/workout-definition.v1'
import { IntervalsPaceError } from './pace-policy'

const maxExecutedSteps = 5000

/** RUN-41 verifies a provider FIT export before marking publication verified.
 * This checks prescription fidelity; it never establishes Garmin/watch receipt. */
export function assertIntervalsWorkoutExport(workout: unknown, bytes: Uint8Array): void {
  try {
    const definition = workoutDefinitionSchema.parse(workout)
    if (definition.sport !== 'RUNNING' || bytes.byteLength > 1024 * 1024) throw new Error()
    const decoder = new Decoder(Stream.fromByteArray(bytes))
    if (!decoder.checkIntegrity()) throw new Error()
    const { messages, errors } = decoder.read()
    const encoded = messages.workoutStepMesgs
    if (
      errors.length ||
      !encoded?.length ||
      encoded.length > maxExecutedSteps ||
      messages.fileIdMesgs?.[0]?.type !== 'workout' ||
      messages.workoutMesgs?.length !== 1 ||
      messages.workoutMesgs[0].sport !== 'running' ||
      messages.workoutMesgs[0].numValidSteps !== encoded.length
    )
      throw new Error()

    const expected: WorkoutStep[] = []
    function expand(nodes: WorkoutNode[]) {
      for (const node of nodes) {
        if (node.type === 'step') expected.push(node)
        else for (let count = 0; count < node.count; count++) expand(node.steps)
        if (expected.length > maxExecutedSteps) throw new Error()
      }
    }
    expand(definition.steps)
    const actual: WorkoutStepMesg[] = []
    const starts = new Map<number, number>()
    for (const [index, step] of encoded.entries()) {
      if (step.messageIndex !== index) throw new Error()
      starts.set(index, actual.length)
      if (step.durationType === 'repeatUntilStepsCmplt') {
        const startIndex = step.durationStep ?? step.durationValue
        const count = step.repeatSteps ?? step.targetValue
        const start = startIndex === undefined ? undefined : starts.get(startIndex)
        if (
          start === undefined ||
          startIndex === undefined ||
          startIndex >= index ||
          !Number.isInteger(count) ||
          count === undefined ||
          count < 1 ||
          count > 100
        )
          throw new Error()
        const cycle = actual.slice(start)
        if (!cycle.length || actual.length + cycle.length * (count - 1) > maxExecutedSteps)
          throw new Error()
        for (let repetition = 1; repetition < count; repetition++) actual.push(...cycle)
      } else {
        actual.push(step)
      }
    }
    if (expected.length !== actual.length) throw new Error()
    for (const [index, prescribed] of expected.entries()) {
      const exported = actual[index]
      const end = prescribed.termination
      if (end.type === 'lap' || exported.durationType !== end.type) throw new Error()
      const expectedDuration =
        end.type === 'time' ? end.durationSeconds * 1000 : end.distanceMeters * 100
      if (exported.durationValue !== expectedDuration) throw new Error()
      const target = prescribed.target
      if (target.type === 'free') {
        if (exported.targetType !== 'open') throw new Error()
      } else if (target.type === 'pace') {
        if (
          exported.targetType !== 'speed' ||
          exported.targetValue !== 0 ||
          exported.customTargetSpeedLow === undefined ||
          exported.customTargetSpeedHigh === undefined
        )
          throw new Error()
        // FIT speed resolution is 1 mm/s. Permit only encoding quantization,
        // never provider widening of an exact target or loss of range endpoints.
        const low = Math.round(exported.customTargetSpeedLow * 1000)
        const high = Math.round(exported.customTargetSpeedHigh * 1000)
        if (
          !Number.isFinite(low) ||
          !Number.isFinite(high) ||
          low <= 0 ||
          low > high ||
          Math.abs(low - Math.round(1_000_000 / target.maxSecondsPerKm)) > 1 ||
          Math.abs(high - Math.round(1_000_000 / target.minSecondsPerKm)) > 1
        )
          throw new Error()
      } else throw new Error()
    }
  } catch {
    throw new IntervalsPaceError('PACE_TARGET_LOST')
  }
}
