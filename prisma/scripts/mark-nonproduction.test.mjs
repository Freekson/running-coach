import { describe, expect, it } from 'vitest'
import { verifyNonproductionTarget } from './mark-nonproduction.mjs'

const endpoint = 'ep-example.us-east-1.aws.neon.tech'
const direct = `postgresql://migrator:synthetic@${endpoint}/coach_dev?schema=public`
const pooled = `postgresql://app:synthetic@ep-example-pooler.us-east-1.aws.neon.tech/coach_dev?schema=public`
const environment = {
  APP_DATABASE_ENV: 'development',
  DIRECT_URL: direct,
  DATABASE_URL: pooled,
}

describe('nonproduction marker target guard', () => {
  it('accepts only a separately confirmed matching endpoint', () => {
    expect(() => verifyNonproductionTarget(environment, endpoint)).not.toThrow()
    expect(() => verifyNonproductionTarget(environment, undefined)).toThrow('endpoint')
    expect(() =>
      verifyNonproductionTarget(environment, 'ep-production.us-east-1.aws.neon.tech'),
    ).toThrow('confirmed nonproduction project')
  })

  it('rejects production labels and deployed environments before database access', () => {
    expect(() =>
      verifyNonproductionTarget({ ...environment, APP_DATABASE_ENV: 'production' }, endpoint),
    ).toThrow('local development/test')
    expect(() =>
      verifyNonproductionTarget({ ...environment, VERCEL_ENV: 'preview' }, endpoint),
    ).toThrow('local development/test')
  })

  it('rejects different runtime and migration schemas or databases', () => {
    expect(() =>
      verifyNonproductionTarget(
        { ...environment, DIRECT_URL: direct.replace('schema=public', 'schema=other') },
        endpoint,
      ),
    ).toThrow('database target')
    expect(() =>
      verifyNonproductionTarget(
        { ...environment, DIRECT_URL: direct.replace('/coach_dev?', '/other?') },
        endpoint,
      ),
    ).toThrow('database target')
  })

  it('rejects a pooled migration URL and a missing runtime URL', () => {
    expect(() =>
      verifyNonproductionTarget({ ...environment, DIRECT_URL: pooled }, endpoint),
    ).toThrow('database target')
    expect(() =>
      verifyNonproductionTarget({ ...environment, DATABASE_URL: undefined }, endpoint),
    ).toThrow('Both Neon database URLs')
  })
})
