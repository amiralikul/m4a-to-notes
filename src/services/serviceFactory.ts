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
import { AiService } from './ai.service';

// Add the business service import
interface TranscriptionBusinessService {
  createTranscription(params: {
    audioBuffer: ArrayBuffer;
    filename: string;
    source: 'web' | 'telegram';
    userMetadata?: Record<string, any>;
  }): Promise<{ transcriptionId: string; estimatedDuration: number }>;
  processTranscription(transcriptionId: string): Promise<void>;
}

class TranscriptionBusinessServiceImpl implements TranscriptionBusinessService {
  constructor(
    private transcriptionOrchestrator: TranscriptionOrchestrator,
    private logger: Logger
  ) {}

  async createTranscription(params: {
    audioBuffer: ArrayBuffer;
    filename: string;
    source: 'web' | 'telegram';
    userMetadata?: Record<string, any>;
  }): Promise<{ transcriptionId: string; estimatedDuration: number }> {
    // Business rules validation
    this.validateBusinessRules(params);
    
    // Delegate to orchestrator (which handles the technical workflow)
    return await this.transcriptionOrchestrator.createTranscription(params);
  }

  async processTranscription(transcriptionId: string): Promise<void> {
    // Business validation before processing
    await this.validateTranscriptionExists(transcriptionId);
    
    // Delegate to orchestrator
    return await this.transcriptionOrchestrator.processTranscription(transcriptionId);
  }

  private validateBusinessRules(params: any): void {
    // Business rule: File size validation
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (params.audioBuffer.byteLength > maxSize) {
      throw new Error(`File size ${params.audioBuffer.byteLength} exceeds maximum of ${maxSize} bytes`);
    }
    
    // Business rule: File type validation
    if (!params.filename.toLowerCase().endsWith('.m4a')) {
      throw new Error('Only M4A files are supported');
    }
    
    // Business rule: Filename validation
    if (params.filename.length > 255) {
      throw new Error('Filename too long');
    }
  }

  private async validateTranscriptionExists(transcriptionId: string): Promise<void> {
    // Add business validation if needed
    if (!transcriptionId || transcriptionId.trim() === '') {
      throw new Error('Transcription ID is required');
    }
  }
}

/**
 * Create all services for a request
 * Simple alternative to complex dependency injection
 */
export function createServices(env: Env, logger: Logger) {
  const database = createOrGetDatabase(env, logger);
  const transcriptionsService = new TranscriptionsService(database, logger);
  const storageService = new StorageService(env.M4A_BUCKET, logger, env);
  const aiService = new AiService(env.OPENAI_API_KEY, logger);
  const queue = env.QUEUE ? env.QUEUE : undefined;
  const transcriptionOrchestrator = new TranscriptionOrchestrator(
    transcriptionsService,
    storageService, 
    aiService,
    logger,
    queue // Inject queue binding
  );

  // Add business service that wraps the orchestrator
  const transcriptionBusinessService = new TranscriptionBusinessServiceImpl(
    transcriptionOrchestrator,
    logger
  );

  return {
    database,
    transcriptionsService,
    storageService,
    aiService,
    transcriptionOrchestrator, // Keep the orchestrator available
    transcriptionBusinessService, // Add business service
    // Add more services as needed
  };
}

/**
 * Type helper for service dependencies
 */
export type Services = ReturnType<typeof createServices>;