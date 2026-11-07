# Local Docker database

The local development database runs in PostgreSQL 18 from [compose.local-db.yml](../compose.local-db.yml). It was populated from the verified NON_PRODUCTION development database on 2026-11-07. The copy is a snapshot; later Neon changes do not sync automatically.

The gitignored `.env.local-db` contains the Docker password and both local connection URLs. The active gitignored `.env` uses those local URLs and retains the existing app authentication settings. The previous development Neon `.env` is saved in the gitignored `.env.neon.backup`. Do not commit or share these files or the Docker volume; they contain credentials and private athlete data.

```powershell
docker compose --env-file .env.local-db -f compose.local-db.yml up -d --wait
pnpm db:status
pnpm dev
```

Restart a running `next dev` process after switching `.env` so it loads the local URLs. The database listens only on `127.0.0.1:55432`. `DATABASE_URL` and `DIRECT_URL` both point to `running_coach_local` there; `APP_DATABASE_ENV=development`. The application uses Prisma's native PostgreSQL connection locally and keeps the Neon adapter for Neon deployments.

To stop the database while keeping its data:

```powershell
docker compose --env-file .env.local-db -f compose.local-db.yml down
```

To switch the active app back to the original development Neon configuration, copy `.env.neon.backup` over `.env` and restart `next dev`. This does not change the Docker database.
