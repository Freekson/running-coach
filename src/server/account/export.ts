import 'server-only'

import { Prisma } from '@prisma/client'
import { AccountUnavailableError } from '@/server/auth/current-user'
import { ownerId, type OwnerContext } from '@/server/authorization/ownership'
import { getPrismaClient } from '@/server/db/client'
import { mergeGarminProjection } from '@/server/garmin/provider-projection'

/** A private account archive, distinct from the consent-filtered AI planning request. */
export async function exportAccount(owner: OwnerContext) {
  const userId = ownerId(owner)
  const prisma = await getPrismaClient()
  return prisma.$transaction(
    async (tx) => {
      const account = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      })
      if (!account || account.status !== 'ACTIVE') throw new AccountUnavailableError()
      const authProfile = await tx.authUser.findFirst({
        where: {
          id: (
            await tx.user.findUniqueOrThrow({
              where: { id: userId },
              select: { authSubject: true },
            })
          ).authSubject,
        },
        select: { name: true, email: true, emailVerified: true, image: true, createdAt: true },
      })
      const where = { userId }
      // Explicit selects keep newly added credential/operational fields out by default.
      return {
        format: 'running-coach.account-export',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        serialization: {
          dates: 'ISO-8601',
          decimals: 'decimal strings',
          integers64: 'decimal strings',
        },
        account,
        authProfile,
        profile: await tx.athleteProfile.findUnique({
          where,
          select: {
            displayName: true,
            birthDate: true,
            sex: true,
            heightCm: true,
            experienceLevel: true,
            preferredTimezone: true,
            measurementSystem: true,
            defaultTrainingDaysPerWeek: true,
            defaultAvailableWeekdays: true,
            updatedAt: true,
          },
        }),
        bodyMeasurements: await tx.bodyMeasurement.findMany({
          where,
          select: {
            id: true,
            measuredAt: true,
            measuredOn: true,
            createdAt: true,
            measurementType: true,
            value: true,
            unit: true,
            source: true,
            sourceExternalId: true,
          },
          orderBy: { id: 'asc' },
        }),
        goals: await tx.goal.findMany({
          where,
          select: {
            id: true,
            name: true,
            type: true,
            distanceMeters: true,
            targetTimeSeconds: true,
            targetCount: true,
            measurementWindow: true,
            targetDate: true,
            surface: true,
            elevationGainM: true,
            archived: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
        drafts: await tx.planDraft.findMany({
          where,
          select: {
            id: true,
            goalId: true,
            sessionsPerWeek: true,
            availableWeekdays: true,
            maxSessionMinutes: true,
            startDate: true,
            timezone: true,
            state: true,
            version: true,
            content: true,
            validatedGoalUpdatedAt: true,
            planId: true,
            baseRevisionId: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
        exchangeRequests: await tx.planExchangeRequest.findMany({
          where,
          select: {
            id: true,
            goalId: true,
            draftId: true,
            draftVersion: true,
            schemaVersion: true,
            generatedAt: true,
            snapshot: true,
          },
          orderBy: { id: 'asc' },
        }),
        plans: await tx.trainingPlan.findMany({
          where,
          select: {
            id: true,
            goalId: true,
            currentRevisionId: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
        revisions: await tx.planRevision.findMany({
          where,
          select: {
            id: true,
            goalId: true,
            planId: true,
            sourceDraftId: true,
            parentRevisionId: true,
            revisionNumber: true,
            snapshot: true,
            approvedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
        workouts: await tx.plannedWorkout.findMany({
          where,
          select: {
            id: true,
            planId: true,
            completedAt: true,
            lockedAt: true,
            completedActivityId: true,
            completedRevisionId: true,
            completionAt: true,
            completionFromActivity: true,
          },
          orderBy: { id: 'asc' },
        }),
        revisionWorkouts: await tx.planRevisionWorkout.findMany({
          where,
          select: {
            planId: true,
            revisionId: true,
            workoutId: true,
            scheduledDate: true,
            timezone: true,
            definition: true,
            cancelled: true,
          },
          orderBy: [{ revisionId: 'asc' }, { workoutId: 'asc' }],
        }),
        reminders: await tx.planReminderState.findMany({
          where,
          select: {
            planId: true,
            fingerprint: true,
            dismissedAt: true,
            snoozedUntil: true,
            updatedAt: true,
          },
          orderBy: [{ planId: 'asc' }, { fingerprint: 'asc' }],
        }),
        connections: await tx.integrationConnection.findMany({
          where,
          select: {
            id: true,
            provider: true,
            externalAccountId: true,
            authMethod: true,
            status: true,
            grantedScopes: true,
            credentialsExpiresAt: true,
            lastSuccessAt: true,
            lastFailureAt: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
        syncRuns: await tx.syncRun.findMany({
          where,
          select: {
            id: true,
            connectionId: true,
            jobType: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            recordsSeen: true,
            recordsWritten: true,
            retryCount: true,
            errorCode: true,
          },
          orderBy: { id: 'asc' },
        }),
        activities: await tx.activity.findMany({
          where,
          select: {
            id: true,
            sourceProvider: true,
            garminAccountId: true,
            externalActivityId: true,
            externalActivityUuid: true,
            sourceRecordType: true,
            sportType: true,
            sourceSportType: true,
            surfaceType: true,
            startedAt: true,
            sourceTimezone: true,
            distanceMeters: true,
            totalMs: true,
            elapsedMs: true,
            movingMs: true,
            avgSpeedMps: true,
            avgHrBpm: true,
            maxHrBpm: true,
            cadence: true,
            elevationGainMeters: true,
            elevationLossMeters: true,
            calories: true,
            activityTitle: true,
            lapImportStatus: true,
            importedAt: true,
            updatedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
        laps: await tx.activityLap.findMany({
          where,
          select: {
            id: true,
            activityId: true,
            lapIndex: true,
            sourceRecordType: true,
            startedAt: true,
            distanceMeters: true,
            elapsedMs: true,
            movingMs: true,
            avgHrBpm: true,
            avgSpeedMps: true,
            cadenceStepsPerMinute: true,
            endedAt: true,
            timerMs: true,
            maxHrBpm: true,
            cadenceCyclesPerMinute: true,
            avgPowerWatts: true,
            maxPowerWatts: true,
            maxSpeedMps: true,
            elevationGainMeters: true,
            elevationLossMeters: true,
          },
          orderBy: [{ activityId: 'asc' }, { lapIndex: 'asc' }],
        }),
        duplicateCandidates: await tx.activityDuplicateCandidate.findMany({
          where,
          select: { id: true, firstActivityId: true, secondActivityId: true, createdAt: true },
          orderBy: { id: 'asc' },
        }),
        health: (
          await tx.dailyHealthMetric.findMany({
            where,
            select: {
              id: true,
              sourceProvider: true,
              garminAccountId: true,
              localDate: true,
              sourceTimezone: true,
              sourceTimezoneBasis: true,
              restingHrBpm: true,
              hrvMs: true,
              sleepDurationMs: true,
              sleepStartedAt: true,
              sleepEndedAt: true,
              sleepLightMs: true,
              sleepDeepMs: true,
              sleepRemMs: true,
              sleepAwakeMs: true,
              sleepSourceTimezone: true,
              sleepTimezoneBasis: true,
              summaryFetchedAt: true,
              sleepFetchedAt: true,
              sleepScore: true,
              steps: true,
              stress: true,
              bodyBattery: true,
              updatedAt: true,
              rawMetadata: true,
            },
            orderBy: { id: 'asc' },
          })
        ).map(({ rawMetadata, ...health }) => {
          const metadata =
            rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
              ? rawMetadata
              : {}
          return {
            ...health,
            providerMetrics: {
              dailySummary: mergeGarminProjection(metadata.garminDailySummaryV1, {
                schemaVersion: 1,
              }),
              sleep: mergeGarminProjection(metadata.garminSleepV1, { schemaVersion: 1 }),
            },
          }
        }),
        publications: await tx.workoutPublication.findMany({
          where,
          select: {
            id: true,
            provider: true,
            localWorkoutId: true,
            approvedRevisionId: true,
            publishRevision: true,
            operation: true,
            status: true,
            externalId: true,
            remoteEventId: true,
            remoteAthleteId: true,
            payload: true,
            lastConfirmedPayload: true,
            attemptCount: true,
            errorCode: true,
            publishedAt: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
        publicationAttempts: await tx.workoutPublicationAttempt.findMany({
          where,
          select: {
            id: true,
            publicationId: true,
            publishRevision: true,
            status: true,
            errorCode: true,
            startedAt: true,
            finishedAt: true,
          },
          orderBy: { id: 'asc' },
        }),
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 },
  )
}

export function serializeAccountExport(value: Awaited<ReturnType<typeof exportAccount>>): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  )
}
