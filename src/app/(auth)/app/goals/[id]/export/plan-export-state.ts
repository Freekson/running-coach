import { z } from 'zod'
import { exportBackgroundSchema, exportConsentSchema } from '@/lib/plan-export'
import { exchangeRequestSchema, EXCHANGE_LIMITS } from '@/schemas/plan-exchange.v1'

export const exportFormStateSchema = z.object({
  constraints: z
    .object({
      sessionsPerWeek: z.number(),
      availableWeekdays: z.array(z.number()),
      maxSessionMinutes: z.number().nullable(),
      startDate: z.string().nullable(),
      timezone: z.string(),
    })
    .optional(),
  consent: exportConsentSchema,
  background: exportBackgroundSchema,
  start: z.string().max(10),
  length: z.enum(['14', '21', '28']),
  result: z
    .object({
      requestId: z.uuid(),
      json: z.string().max(EXCHANGE_LIMITS.requestBytes),
      prompt: z.string().max(EXCHANGE_LIMITS.requestBytes),
      bytes: z.number().nonnegative(),
    })
    .refine((artifact) => {
      try {
        const packet = z.object({ request: exchangeRequestSchema }).parse(JSON.parse(artifact.json))
        return packet.request.requestId === artifact.requestId
      } catch {
        return false
      }
    })
    .optional(),
  race: z.object({
    date: z.string().max(10),
    distance: z.string().max(20),
    seconds: z.string().max(20),
    kind: z.enum(['race', 'test', 'historical_pb']),
  }),
})
export type ExportFormState = z.infer<typeof exportFormStateSchema>
