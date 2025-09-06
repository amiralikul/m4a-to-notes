/**
 * Transcription Orchestrator
 * Handles the business logic of transcription workflow
 * Uses domain-focused TranscriptionsService for data operations
 */
import { TranscriptionsService, TranscriptionStatus } from './transcriptions';
import { StorageService } from './storage';
import { transcribeAudio } from './transcription';
import Logger from '../logger';
import type { Queue } from '@cloudflare/workers-types'

export class TranscriptionOrchestrator {
  constructor(
    private transcriptionsService: TranscriptionsService,
    private storageService: StorageService,
    private openaiKey: string,
    private logger: Logger,
    private queue?: Queue<any> // Cloudflare Queue binding
  ) {}



  /**
   * Process a queued transcription (idempotent - safe to retry)
   */
  async processTranscription(transcriptionId: string): Promise<void> {
    this.logger.info('Starting transcription processing', { transcriptionId });

    // Get the transcription
    const transcription = await this.transcriptionsService.findById(transcriptionId);
    if (!transcription) {
      throw new Error(`Transcription not found: ${transcriptionId}`);
    }

    // Idempotency check: if already completed or failed, don't reprocess
    if (transcription.status === TranscriptionStatus.COMPLETED) {
      this.logger.info('Transcription already completed, skipping processing', { 
        transcriptionId, 
        status: transcription.status 
      });
      return;
    }

    if (transcription.status === TranscriptionStatus.FAILED) {
      this.logger.info('Transcription already failed, skipping processing', { 
        transcriptionId, 
        status: transcription.status 
      });
      return;
    }

    // If transcription is already processing, we could be in a retry scenario
    // Allow processing to continue but log this situation
    if (transcription.status === TranscriptionStatus.PROCESSING) {
      this.logger.warn('Transcription already in processing state, continuing (possible retry)', { 
        transcriptionId, 
        status: transcription.status,
        progress: transcription.progress
      });
    } else if (transcription.status !== TranscriptionStatus.PENDING) {
      throw new Error(`Transcription ${transcriptionId} is in unexpected status: ${transcription.status}`);
    }

    try {
      // Mark as processing
      await this.transcriptionsService.markStarted(transcriptionId, 5);

      // Download the audio file
      this.logger.info('Downloading audio file', { transcriptionId, audioKey: transcription.audioKey });
      const audioBuffer = await this.storageService.downloadContent(transcription.audioKey);
      
      await this.transcriptionsService.updateProgress(transcriptionId, 20);

      // Transcribe
      this.logger.info('Starting transcription', { transcriptionId, fileSize: audioBuffer.byteLength });
      const transcriptText = await transcribeAudio(audioBuffer, this.openaiKey, this.logger);
      
      if (!transcriptText.trim()) {
        throw new Error('No speech detected in audio');
      }

      await this.transcriptionsService.updateProgress(transcriptionId, 90);

      // Mark as completed
      const preview = transcriptText.substring(0, 150) + (transcriptText.length > 150 ? '...' : '');
      await this.transcriptionsService.markCompleted(transcriptionId, preview, transcriptText);

      // Clean up: delete processed audio file
      try {
        await this.storageService.deleteObject(transcription.audioKey);
        this.logger.info('Cleaned up processed audio file', { 
          transcriptionId, 
          audioKey: transcription.audioKey
        });
      } catch (cleanupError) {
        // Don't fail the transcription if cleanup fails
        const errorMessage = cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup error';
        this.logger.warn('Failed to clean up audio file', {
          transcriptionId,
          audioKey: transcription.audioKey,
          error: errorMessage
        });
      }

      this.logger.info('Transcription completed successfully', { 
        transcriptionId, 
        transcriptionLength: transcriptText.length 
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Transcription processing failed', { 
        transcriptionId, 
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        // Log additional error details for debugging
        errorType: error?.constructor?.name,
        audioKey: transcription.audioKey,
        filename: transcription.filename
      });

      try {
        // Determine error code based on error type/message
        let errorCode = 'TRANSCRIPTION_ERROR';
        if (errorMessage.includes('OpenAI') || errorMessage.includes('API')) {
          errorCode = 'OPENAI_API_ERROR';
        } else if (errorMessage.includes('No speech detected')) {
          errorCode = 'NO_SPEECH_DETECTED';
        } else if (errorMessage.includes('File size') || errorMessage.includes('too large')) {
          errorCode = 'FILE_SIZE_ERROR';
        }
        
        // Mark as failed in database with more specific error code
        await this.transcriptionsService.markFailed(transcriptionId, errorCode, errorMessage);

        // Attempt cleanup of uploaded audio file on failure
        if (transcription.audioKey) {
          try {
            await this.storageService.deleteObject(transcription.audioKey);
            this.logger.info('Cleaned up audio file after transcription failure', { 
              transcriptionId, 
              audioKey: transcription.audioKey
            });
          } catch (cleanupError) {
            this.logger.warn('Failed to clean up audio file after transcription failure', {
              transcriptionId,
              audioKey: transcription.audioKey,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup error'
            });
          }
        }
      } catch (dbError) {
        this.logger.error('Failed to mark transcription as failed in database', {
          transcriptionId,
          originalError: errorMessage,
          dbError: dbError instanceof Error ? dbError.message : 'Unknown DB error'
        });
      }

      throw error;
    }
  }

  /**
   * Create and enqueue a new transcription
   */
  async createTranscription(params: {
    audioBuffer: ArrayBuffer;
    filename: string;
    source: 'web' | 'telegram';
    userMetadata?: Record<string, any>;
  }): Promise<{ transcriptionId: string; estimatedDuration: number }> {
    this.logger.info('Creating transcription', { 
      filename: params.filename,
      fileSize: params.audioBuffer.byteLength,
      source: params.source
    });

    // Validate file size (business rule)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (params.audioBuffer.byteLength > maxSize) {
      throw new Error(`File size ${params.audioBuffer.byteLength} exceeds maximum of ${maxSize} bytes`);
    }

    // Store the audio file
    const audioKey = `audio/${crypto.randomUUID()}-${params.filename}`;
    await this.storageService.uploadContent(
      audioKey, 
      params.audioBuffer, 
      this.guessMimeType(params.filename)
    );

    // Create the transcription record
    const transcriptionId = await this.transcriptionsService.create({
      audioKey,
      filename: params.filename,
      source: params.source as any,
      userMetadata: params.userMetadata || {}
    });

    // Enqueue transcription for processing (minimal event payload)
    if (this.queue) {
      try {
        await this.queue.send({
          eventType: 'transcription.requested',
          transcriptionId,
          timestamp: new Date().toISOString()
        });
        
        this.logger.info('Transcription enqueued successfully', {
          transcriptionId,
          queueName: 'transcribe'
        });
      } catch (queueError) {
        this.logger.error('Failed to enqueue transcription', {
          transcriptionId,
          error: queueError instanceof Error ? queueError.message : 'Unknown queue error'
        });
        
        // Mark transcription as failed since we couldn't queue it
        await this.transcriptionsService.markFailed(transcriptionId, 'QUEUE_ERROR', 'Failed to enqueue transcription for processing');
        throw new Error('Failed to enqueue transcription');
      }
    } else {
      this.logger.warn('Queue not configured, transcription created but not enqueued', {
        transcriptionId
      });
    }

    // Estimate processing time (simple heuristic)
    const fileSizeMB = params.audioBuffer.byteLength / (1024 * 1024);
    const estimatedDuration = Math.max(5, fileSizeMB * 2); // 2 seconds per MB, minimum 5 seconds

    this.logger.info('Transcription created and queued', { 
      transcriptionId, 
      audioKey, 
      estimatedDuration 
    });

    return { transcriptionId, estimatedDuration };
  }

  private guessMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();
    switch (ext) {
      case 'm4a': return 'audio/m4a';
      case 'mp3': return 'audio/mpeg';
      case 'wav': return 'audio/wav';
      case 'ogg': return 'audio/ogg';
      default: return 'audio/m4a';
    }
  }
}