import { drizzle } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client/web';
import * as schema from './schema';
import Logger from '../logger';


let client: Client | null = null;
let db: ReturnType<typeof drizzle> | null = null;
export function createDatabase(env: Env, logger: Logger) {
  if (!env.TURSO_DATABASE_URL) {
    logger.error('Missing TURSO_DATABASE_URL environment variable');
    throw new Error('TURSO_DATABASE_URL is required');
  }

  // Auth token is optional for local URLs (file:// or http://localhost)
  const isLocalUrl = env.TURSO_DATABASE_URL.startsWith('file:') || 
                     env.TURSO_DATABASE_URL.startsWith('http://localhost') ||
                     env.TURSO_DATABASE_URL.startsWith('http://127.0.0.1');
  
  if (!isLocalUrl && !env.TURSO_AUTH_TOKEN) {
    logger.error('Missing TURSO_AUTH_TOKEN for remote database');
    throw new Error('TURSO_AUTH_TOKEN is required for remote Turso databases');
  }

  try {
    if (!client) {
      client = createClient({
        url: env.TURSO_DATABASE_URL,
        authToken: isLocalUrl ? undefined : env.TURSO_AUTH_TOKEN,
      });
    }

    if (!db) {
      db = drizzle({ client, schema });
    }

    logger.info('Database connection established', {
      url: env.TURSO_DATABASE_URL.replace(/\/\/.*@/, '//*****@') // Mask credentials in logs
    });

    return db;
  } catch (error: unknown) {
    logger.error('Failed to create database connection', {
      error: error instanceof Error ? error.message : String(error),
      url: env.TURSO_DATABASE_URL?.replace(/\/\/.*@/, '//*****@')
    });
    throw error;
  }
}

export type Database = ReturnType<typeof createDatabase>;


export * from './schema';