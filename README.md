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

**Planned:** Neon PostgreSQL, Prisma, authentication provider, Garmin and Intervals.icu integrations.

## Local Development

Use Node.js 22 and pnpm 10.30.3.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000.

The `/status` route provides a deployment smoke test.

The current application shell does not require environment variables or a database connection.

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

Vercel automatically creates Preview deployments for non-production branches and Production deployments from `main`.

### Deployment Protection

While the application is under development and before application-level authentication is implemented, Vercel Authentication with **All Deployments** protection is recommended.

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
- [Dark theme and design tokens](docs/design-tokens.md)
- [Linear project and technical specifications](https://linear.app/fr-running-coach/project/running-coach-2730d3d0f69a)

Implementation requirements and acceptance criteria are tracked in Linear. Repository architecture rules and coding standards are maintained alongside the source code.
