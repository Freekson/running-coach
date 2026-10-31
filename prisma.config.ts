import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Prisma 6 validates both schema URLs even for generate/validate without a DB.
// These placeholders are used only by the CLI; runtime access checks the real URL.
const runtimeUrl = process.env.DATABASE_URL
const unavailableUrl = 'postgresql://unconfigured:unconfigured@127.0.0.1:1/unconfigured'
process.env.DATABASE_URL ??= unavailableUrl
process.env.DIRECT_URL ??= unavailableUrl

const directUrl = process.env.DIRECT_URL
if (directUrl !== unavailableUrl) {
  try {
    const direct = new URL(directUrl)
    if (direct.hostname.includes('-pooler.')) {
      throw new Error('pooled host')
    }
    const databaseSchema = (url: URL) => url.searchParams.get('schema') || 'public'
    if (databaseSchema(direct) !== 'public') {
      throw new Error('unsupported schema')
    }
    if (runtimeUrl) {
      const runtime = new URL(runtimeUrl)
      if (
        direct.hostname !== runtime.hostname.replace('-pooler.', '.') ||
        direct.port !== runtime.port ||
        direct.pathname !== runtime.pathname ||
        databaseSchema(direct) !== databaseSchema(runtime)
      ) {
        throw new Error('different database')
      }
    }
  } catch {
    throw new Error('DIRECT_URL must target the same database and schema without the pooler')
  }
}

// Prisma CLI uses only the direct URL. The invalid fallback permits code
// generation without database credentials, but prevents migrations from
// accidentally using the pooled runtime URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: directUrl,
    directUrl,
  },
})
