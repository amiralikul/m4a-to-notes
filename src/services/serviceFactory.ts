/**
 * Simple Service Factory
 * Creates and configures services with their dependencies
 * No complex DI container - just simple factory functions
 */
import { createOrGetDatabase } from '../db';
import { TranscriptionsService } from './transcriptions';
import { StorageService } from './storage';
import { TranscriptionOrchestrator } from './transcriptionOrchestrator';
import Logger from '../logger';

/**
 * Create all services for a request
 * Simple alternative to complex dependency injection
 */
export function createServices(env: Env, logger: Logger) {
  const database = createOrGetDatabase(env, logger);
  const transcriptionsService = new TranscriptionsService(database, logger);
  const storageService = new StorageService(env.M4A_BUCKET, logger, env);
  
  const transcriptionOrchestrator = new TranscriptionOrchestrator(
    transcriptionsService,
    storageService, 
    env.OPENAI_API_KEY,
    logger,
    env.QUEUE // Inject queue binding
  );

  return {
    database,
    transcriptionsService,
    storageService,
    transcriptionOrchestrator,
    // Add more services as needed
  };
}

/**
 * Type helper for service dependencies
 */
export type Services = ReturnType<typeof createServices>;