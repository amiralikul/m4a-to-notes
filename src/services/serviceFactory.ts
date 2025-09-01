/**
 * Simple Service Factory
 * Creates and configures services with their dependencies
 * No complex DI container - just simple factory functions
 */
import { createOrGetDatabase } from '../db';
import { JobsService } from './jobs';
import { StorageService } from './storage';
import { TranscriptionOrchestrator } from './transcriptionOrchestrator';
import Logger from '../logger';

/**
 * Create all services for a request
 * Simple alternative to complex dependency injection
 */
export function createServices(env: Env, logger: Logger) {
  const database = createOrGetDatabase(env, logger);
  const jobsService = new JobsService(database, logger);
  const storageService = new StorageService(env.M4A_BUCKET, logger, env);
  
  const transcriptionOrchestrator = new TranscriptionOrchestrator(
    jobsService,
    storageService, 
    env.OPENAI_API_KEY,
    logger,
    env.QUEUE // Inject queue binding
  );

  return {
    database,
    jobsService,
    storageService,
    transcriptionOrchestrator,
    // Add more services as needed
  };
}

/**
 * Type helper for service dependencies
 */
export type Services = ReturnType<typeof createServices>;