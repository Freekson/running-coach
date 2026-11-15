import { z } from 'zod'
import { exchangeRequestSchema, exchangeResponseSchema } from './plan-exchange.v1'

const semanticPolicy =
  'Zod is authoritative. Also enforce calendar validity, timezone/units, coverage/null semantics, consent, unique IDs, matching request/mode/draft and revision versions, phase continuity, allowed future dates/identities and schedule constraints. Recheck live ownership, versions and locks before approval; schema validity does not approve or publish.'
export const planExchangeRequestJsonSchema = {
  ...z.toJSONSchema(exchangeRequestSchema, { target: 'draft-2020-12', reused: 'ref' }),
  title: 'PlanExchangeRequest v1',
  $comment: semanticPolicy,
}
export const planExchangeResponseJsonSchema = {
  ...z.toJSONSchema(exchangeResponseSchema, { target: 'draft-2020-12', reused: 'ref' }),
  title: 'PlanExchangeResponse v1',
  $comment: semanticPolicy,
}
