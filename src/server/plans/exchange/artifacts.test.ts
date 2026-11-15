import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { format, resolveConfig } from 'prettier'
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth/current-user', () => ({ isVerifiedCurrentUser: () => true }))
import { getOwnerContext } from '@/server/authorization/ownership'
import {
  exchangeRequestSchema,
  exchangeResponseSchema,
  responseSchemaForRequest,
} from '@/schemas/plan-exchange.v1'
import {
  planExchangeRequestJsonSchema,
  planExchangeResponseJsonSchema,
} from '@/schemas/plan-exchange.v1.json-schema'
import {
  fixtureId,
  initialResponseFixture,
  refreshResponseFixture,
  validRequestFixtures,
} from './fixtures'
import { createPlanExchangePackage } from './package'

const owner = getOwnerContext({ id: fixtureId(900), role: 'USER', email: null })
const root = path.resolve('docs/fixtures/plan-exchange-v1')

describe('generated RUN-34 artifacts from authoritative Zod and synthetic fixtures', () => {
  it('keeps committed JSON schemas and fixtures reproducible from a clean checkout', async () => {
    const requests = validRequestFixtures(owner)
    const initial = initialResponseFixture()
    const refresh = refreshResponseFixture()
    const invalid: Record<
      string,
      { kind: 'request' | 'response'; requestFixture: string; value: unknown; expectedPath: string }
    > = {
      'unsupported-version': {
        kind: 'request',
        requestFixture: 'no-garmin-account',
        value: { ...requests['no-garmin-account'], schemaVersion: 2 },
        expectedPath: 'schemaVersion',
      },
      'unknown-mode': {
        kind: 'request',
        requestFixture: 'no-garmin-account',
        value: { ...requests['no-garmin-account'], mode: 'automatic' },
        expectedPath: 'mode',
      },
      'stale-request': {
        kind: 'response',
        requestFixture: 'no-garmin-account',
        value: { ...initial, requestId: fixtureId(999) },
        expectedPath: 'requestId',
      },
      'stale-draft': {
        kind: 'response',
        requestFixture: 'no-garmin-account',
        value: { ...initial, draftVersion: 999 },
        expectedPath: 'draftVersion',
      },
      'stale-revision': {
        kind: 'response',
        requestFixture: 'refresh',
        value: { ...refresh, baseRevisionId: fixtureId(999) },
        expectedPath: 'baseRevisionId',
      },
      'locked-workout': {
        kind: 'response',
        requestFixture: 'refresh',
        value: { ...refresh, operations: [{ operation: 'cancel', workoutId: fixtureId(201) }] },
        expectedPath: 'operations.0.workoutId',
      },
      'malformed-steps': {
        kind: 'response',
        requestFixture: 'no-garmin-account',
        value: {
          ...initial,
          workouts: [
            {
              ...initial.workouts[0],
              definition: { ...initial.workouts[0].definition, steps: [] },
            },
          ],
        },
        expectedPath: 'workouts.0.definition.steps',
      },
    }
    const artifacts: Record<string, unknown> = {
      'request.schema.json': planExchangeRequestJsonSchema,
      'response.schema.json': planExchangeResponseJsonSchema,
      'initial.response.json': initial,
      'refresh.response.json': refresh,
      'initial.package.json': createPlanExchangePackage(requests['no-garmin-account']),
      'refresh.package.json': createPlanExchangePackage(requests.refresh),
      ...Object.fromEntries(
        Object.entries(requests).map(([name, value]) => [name + '.request.json', value]),
      ),
      ...Object.fromEntries(
        Object.entries(invalid).map(([name, value]) => ['invalid/' + name + '.json', value]),
      ),
    }
    const config = await resolveConfig(path.join(root, 'request.schema.json'))
    for (const [name, value] of Object.entries(artifacts)) {
      const file = path.join(root, name)
      const expected = await format(JSON.stringify(value), { ...config, parser: 'json' })
      if (process.env.UPDATE_PLAN_EXCHANGE_ARTIFACTS === '1') {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, expected)
      }
      expect(await readFile(file, 'utf8'), name).toBe(expected)
    }
    for (const request of Object.values(requests)) {
      expect(exchangeRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request)
      const response = request.mode === 'refresh' ? refresh : initial
      expect(responseSchemaForRequest(request).parse(JSON.parse(JSON.stringify(response)))).toEqual(
        response,
      )
    }
    expect(exchangeResponseSchema.parse(initial)).toEqual(initial)
    for (const fixture of Object.values(invalid)) {
      const schema =
        fixture.kind === 'request'
          ? exchangeRequestSchema
          : responseSchemaForRequest(requests[fixture.requestFixture])
      const parsed = schema.safeParse(fixture.value)
      expect(parsed.success).toBe(false)
      if (!parsed.success)
        expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain(
          fixture.expectedPath,
        )
    }
  }, 30000)
})
