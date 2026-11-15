import { createServer } from 'node:http'
import {
  Encoder,
  Profile,
  type FileIdMesg,
  type WorkoutMesg,
  type WorkoutStepMesg,
} from '@garmin/fitsdk'
import { randomUUID } from 'node:crypto'
import type { ApprovedPublicationWorkout } from './publication-contract'
import { remotePublicationEventSchema, type RemotePublicationEvent } from './publication-client'
import { z } from 'zod'

export function approvedPublicationFixture(userId: string): ApprovedPublicationWorkout {
  return {
    userId,
    localWorkoutId: randomUUID(),
    revisionId: randomUUID(),
    approved: true,
    cancelled: false,
    locked: false,
    schedule: { localDate: '2027-03-21', timeZone: 'Asia/Tokyo' },
    workout: {
      schemaVersion: 1,
      name: 'Synthetic easy run',
      sport: 'RUNNING',
      steps: [
        {
          type: 'step',
          termination: { type: 'time', durationSeconds: 600 },
          target: { type: 'free' },
        },
      ],
    },
  }
}

export function publicationFitFixture(pace = false) {
  const encoder = new Encoder()
  const fileId: FileIdMesg = {
    type: 'workout',
    manufacturer: 'development',
    product: 1,
  }
  const workout: WorkoutMesg = { sport: 'running', numValidSteps: 1 }
  const step: WorkoutStepMesg = {
    messageIndex: 0,
    durationType: 'time',
    durationValue: 600000,
    targetType: pace ? 'speed' : 'open',
    ...(pace
      ? {
          targetValue: 0,
          customTargetValueLow: Math.round(1_000_000 / 330),
          customTargetValueHigh: Math.round(1_000_000 / 300),
        }
      : {}),
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)
  encoder.onMesg(Profile.MesgNum.WORKOUT, workout)
  encoder.onMesg(Profile.MesgNum.WORKOUT_STEP, step)
  return encoder.close()
}

/** Stateful local HTTP stand-in, based on the documented calendar endpoints.
 * No live credentials, external requests or provider activity ingestion. */
export async function publicationProviderFixture() {
  const events = new Map<string, Map<string, RemotePublicationEvent>>()
  const calls: { method: string; path: string; athlete: string }[] = []
  let sequence = 0
  const control = {
    loseWriteResponse: false,
    failReads: false,
    hangReads: false,
    invalidExport: false,
    paceExport: false,
    rateLimit: false,
    rejectNextWrite: false,
    accountOverride: '',
    beforeWrite: undefined as (() => Promise<void>) | undefined,
    afterWrite: undefined as (() => void) | undefined,
  }
  const server = createServer(async (req, res) => {
    try {
      const key = Buffer.from((req.headers.authorization ?? '').replace('Basic ', ''), 'base64')
        .toString('utf8')
        .replace('API_KEY:', '')
      const athlete = control.accountOverride || key
      let calendar = events.get(athlete)
      if (!calendar) {
        calendar = new Map()
        events.set(athlete, calendar)
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace('/api/v1/athlete/0', '')
      calls.push({ method: req.method ?? '', path, athlete })
      res.setHeader('Content-Type', 'application/json')
      if (control.rateLimit) {
        res.writeHead(429)
        res.end('{}')
        return
      }
      if (req.method === 'GET' && path === '') {
        res.end(JSON.stringify({ id: athlete }))
        return
      }
      if (req.method === 'GET') {
        if (control.hangReads) return
        if (control.failReads) {
          res.writeHead(503)
          res.end('private provider error')
          return
        }
        if (path === '/sport-settings') {
          res.end(
            JSON.stringify([
              {
                id: 1,
                types: ['Run'],
                threshold_pace: 1000 / 300,
                pace_zones: [77.5, 87.7, 94.3, 100, 103.4, 111.5, 999],
              },
            ]),
          )
          return
        }
        if (path === '/events') {
          res.end(
            JSON.stringify(
              [...calendar.values()].filter(
                (event) => event.start_date_local?.slice(0, 10) === url.searchParams.get('oldest'),
              ),
            ),
          )
          return
        }
        const id = Number(path.split('/')[2])
        const event = [...calendar.values()].find((item) => item.id === id)
        if (!event) {
          res.writeHead(404)
          res.end('{}')
          return
        }
        if (path.endsWith('/download.fit')) {
          res.setHeader('Content-Type', 'application/octet-stream')
          res.end(
            control.invalidExport
              ? Buffer.from('invalid FIT')
              : publicationFitFixture(control.paceExport),
          )
          return
        }
        res.end(JSON.stringify(event))
        return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk.toString()
      if (control.rejectNextWrite) {
        control.rejectNextWrite = false
        res.writeHead(429)
        res.end('{}')
        return
      }
      if (req.method === 'POST' && path === '/events/bulk') {
        await control.beforeWrite?.()
        const body = z.array(remotePublicationEventSchema.omit({ id: true })).parse(JSON.parse(raw))
        const written = body.map((item) => {
          if (!item.external_id) throw new Error('Missing stable ID')
          const event = { ...item, id: calendar.get(item.external_id)?.id ?? ++sequence }
          calendar.set(item.external_id, event)
          return event
        })
        control.afterWrite?.()
        if (control.loseWriteResponse) {
          control.loseWriteResponse = false
          res.destroy()
          return
        }
        res.end(JSON.stringify(written))
        return
      }
      if (req.method === 'PUT' && path === '/events/bulk-delete') {
        await control.beforeWrite?.()
        const body = z.array(z.object({ id: z.number().int().positive() })).parse(JSON.parse(raw))
        for (const event of body) {
          const entry = [...calendar.entries()].find(([, item]) => item.id === event.id)
          if (entry) calendar.delete(entry[0])
        }
        control.afterWrite?.()
        if (control.loseWriteResponse) {
          control.loseWriteResponse = false
          res.destroy()
          return
        }
        res.end('{}')
        return
      }
      res.writeHead(501)
      res.end('{}')
    } catch {
      res.writeHead(500)
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address')
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init)
  }
  return {
    control,
    events,
    calls,
    fetcher,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
