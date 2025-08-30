import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.NODE_ENV === 'production' ? process.env.TURSO_DATABASE_URL! : './local.db',
    authToken: process.env.NODE_ENV === 'production' ? process.env.TURSO_AUTH_TOKEN! : undefined,
  },
});


