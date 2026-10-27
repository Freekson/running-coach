# Running Coach — Agent Instructions

## Product and architecture

- Private invite-only multi-user running/endurance planning app: Next.js App Router, TypeScript, Prisma, Neon PostgreSQL, Vercel.
- One Next.js app for MVP. Do not add NestJS, Redis, Kafka, or a queue system without an architecture decision.
- Source of truth: Linear issue acceptance criteria + relevant docs in `docs/`. Do not read every doc for an unrelated small change.
- Follow [Engineering Workflow & Code Quality](https://linear.app/fr-running-coach/project/running-coach-2730d3d0f69a) for issue and PR evidence.
- Business logic and external provider adapters belong in `src/server/<domain>/`; route handlers and server actions authenticate, authorize, and delegate to services. UI components/hooks must not import server modules.

## Non-negotiable invariants

- Personal data is always owner-scoped. Derive `userId` from a verified session on the server; never from untrusted client input. Check nested resource ownership. Tests must exercise a _different user_.
- Only ADMIN can create/list/resend/revoke invitations. Invitees start as USER. ADMIN cannot implicitly read another user's health data.
- Third-party credentials and encryption keys never reach browser bundles, logs, AI JSON exports or fixture files.
- Workout definitions are canonical, versioned, validated at runtime. Adapters handle Garmin/Intervals.icu mapping.
- A saved, approved training plan revision is immutable. Refresh may alter only approved future workouts; never rewrite completed history.
- External API effects need stable IDs, retry protections and truthful sync statuses. Published to Intervals.icu != verified on Garmin watch.
- Treat all imported JSON and third-party payloads as untrusted. Only explicit human approval can publish an AI-created training plan.

## Code conventions

- TypeScript strict mode. Prefer narrow types and Zod validation at untrusted boundaries; don't add broad `any`, casts or blanket lint disables to make checks pass.
- Keep changes issue-scoped and simple; use existing libraries and architecture before creating new abstractions.
- Source formatting: Prettier. Correctness linting: ESLint. Type correctness: `tsc --noEmit`.
- Add unit/contract tests for domain changes, integration tests for auth, sync and DB changes, and include negative-path / ownership cases.

## Definition of done

- Meet all applicable Linear acceptance criteria, including error and unauthorized cases.
- Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` if build dependencies/env are available.
- Report actual command results, code changes, migrations, test coverage, and unverified integration assumptions. Never claim a check ran if it did not.
- Open or review a PR referencing the Linear issue; don't silently expand scope.

## Project skills

- Use `.agents/skills/implement-linear-issue/SKILL.md` when implementing a RUN-* ticket.
- Use `.agents/skills/architecture-review/SKILL.md` for an independent PR or diff review.
- Use `.agents/skills/db-migration/SKILL.md` when changing Prisma schema or migrations.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
