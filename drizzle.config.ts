import { defineConfig } from 'drizzle-kit';

// Use explicit database configuration instead of NODE_ENV
const isLocalDb = process.env.DATABASE_ENV === 'local' || 
                  (!process.env.TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL.includes('127.0.0.1'));

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    // url: isLocalDb ? './local.db' : process.env.TURSO_DATABASE_URL!,
    // authToken: isLocalDb ? undefined : process.env.TURSO_AUTH_TOKEN!,
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  },
});


