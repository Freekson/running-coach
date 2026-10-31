# Running Coach

A private, invite-only endurance training application for planning workouts, tracking progress, and managing personalized training programs.

**Live application:** https://running-coach-lime.vercel.app/  
**Development roadmap:** https://linear.app/fr-running-coach/project/running-coach-2730d3d0f69a

## Project Status

**Early development — application foundation.**

The repository currently contains the Next.js application shell, deployment smoke page, development tooling, and CI checks.

Authentication, athlete profiles, database persistence, Garmin/Intervals.icu integrations, and training plan generation are planned features and are not yet implemented.

## Planned Features

- Multi-user accounts with administrator-only invitations
- Athlete profiles, goals, and training preferences
- Garmin activity and health data integration, subject to API availability and permissions
- Structured workout creation and scheduling
- Intervals.icu integration for workout publishing
- Long-term training plans with rolling 2–4-week detailed workouts
- AI-assisted plan generation through JSON file exchange
- Training statistics, progress tracking, and browser notifications
- Advanced analytics and personal achievements after MVP

See the [Linear roadmap](https://linear.app/fr-running-coach/project/running-coach-2730d3d0f69a) for implementation progress.

## Tech Stack

- Next.js 16, React, TypeScript
- pnpm
- ESLint, Prettier
- Vitest
- GitHub Actions
- Vercel

**Planned:** authentication provider, Garmin and Intervals.icu integrations.

**Database foundation:** Neon PostgreSQL and Prisma 6.19.0. See
[database operations](docs/database-operations.md) for isolated environments,
direct migrations, pooled runtime connectivity, and the test procedure.

## Local Development

Use Node.js 22 and pnpm 10.30.3.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000.

The `/status` route provides a deployment smoke test.

The current public application shell does not query the database. Database-backed
server features require the environment variables in `.env.example`.

## Code Quality

Run the following checks before opening a pull request:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Automatic fixes:

```bash
pnpm format
pnpm lint:fix
```

The repository includes editor formatting recommendations, pre-commit hooks, and GitHub Actions quality checks.

CI runs validation independently on pull requests and configured branch pushes. Next.js builds do not replace explicit ESLint checks.

## Development Workflow

Branch strategy:

| Branch           | Purpose                         |
| ---------------- | ------------------------------- |
| `main`           | Production releases             |
| `development`    | Integration and preview testing |
| Feature branches | Individual Linear issues        |

Development process:

1. Select a Linear issue and review its acceptance criteria.
2. Create a feature branch from `development`.
3. Implement changes following `AGENTS.md`.
4. Run quality checks and tests.
5. Open a pull request targeting `development`.
6. Complete code review and merge after successful CI.
7. Release tested changes from `development` into `main`.

Changes should not be pushed or merged automatically by coding agents without explicit user authorization.
Protect both `development` and `main` in GitHub and require the `validate` job
from **Quality checks** before merging. Migration and deployment jobs run only
after a merge to their trusted branch.

## Deployment

The application is deployed on Vercel.

**Production:** https://running-coach-lime.vercel.app/

Configuration:

| Setting           | Value                            |
| ----------------- | -------------------------------- |
| Framework         | Next.js                          |
| Node.js           | 22.x                             |
| Production Branch | `main`                           |
| Root Directory    | Repository root                  |
| Install Command   | `pnpm install --frozen-lockfile` |
| Build Command     | `pnpm build`                     |

Native Vercel Git deployments are disabled in `vercel.json`. GitHub Actions
deploys a merge to `development` only after CI and development migrations
succeed, and deploys a merge to `main` only after CI and production migrations
succeed. See [release operations](docs/release-operations.md) for required
GitHub Environment settings, rollback, and secret rotation.

### Deployment Protection

Before exposing any deployment while application-level authentication is not
implemented, set **Security → Deployment Protection → Vercel Authentication →
All Deployments**. Confirm the setting in the Vercel project dashboard and
check `/status` on both a Preview and Production deployment.

Once Running Coach has its own authenticated, invite-only access control, production access can be managed by the application while keeping Preview deployments protected.

The `/status` endpoint confirms application rendering only. It does not validate database connectivity, authentication, or external integrations.

### Environment Security

- Never commit credentials or `.env.local` files.
- Never expose provider API keys, database credentials, or encryption secrets through `NEXT_PUBLIC_*` variables.
- Keep production and preview databases and secrets isolated.
- Use synthetic data in tests and public examples.

## Architecture & Documentation

- [Codex / agent instructions](AGENTS.md)
- [Architecture guardrails](docs/architecture-guardrails.md)
- [Database design](docs/database-design.md)
- [System architecture](docs/system-architecture.md)
- [Database operations](docs/database-operations.md)
- [Dark theme and design tokens](docs/design-tokens.md)
- [Linear project and technical specifications](https://linear.app/fr-running-coach/project/running-coach-2730d3d0f69a)

Implementation requirements and acceptance criteria are tracked in Linear. Repository architecture rules and coding standards are maintained alongside the source code.
