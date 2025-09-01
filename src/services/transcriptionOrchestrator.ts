/**
 * Simple Transcription Orchestrator
 * Handles the business logic of transcription workflow
 * Keeps JobsService focused on data operations
 */
import { JobsService, JobStatus } from './jobs';
import { StorageService } from './storage';
import { transcribeAudio } from './transcription';
import Logger from '../logger';
import type { Queue } from '@cloudflare/workers-types'

export class TranscriptionOrchestrator {
  constructor(
    private jobsService: JobsService,
    private storageService: StorageService,
    private openaiKey: string,
    private logger: Logger,
    private queue?: Queue<any> // Cloudflare Queue binding
  ) {}



  /**
   * Process a queued transcription job
   */
  async processJob(jobId: string): Promise<void> {
    this.logger.info('Starting job processing', { jobId });

    // Get the job
    const job = await this.jobsService.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== JobStatus.QUEUED) {
      throw new Error(`Job ${jobId} is not in queued status: ${job.status}`);
    }

    try {
      // Mark as processing
      await this.jobsService.markProcessing(jobId, 5);

      // Download the audio file
      this.logger.info('Downloading audio file', { jobId, objectKey: job.objectKey });
      const audioBuffer = await this.storageService.downloadContent(job.objectKey);
      
      await this.jobsService.updateProgress(jobId, 20);

      // Transcribe
      this.logger.info('Starting transcription', { jobId, fileSize: audioBuffer.byteLength });
      const transcription = await transcribeAudio(audioBuffer, this.openaiKey, this.logger);
      
      if (!transcription.trim()) {
        throw new Error('No speech detected in audio');
      }

      await this.jobsService.updateProgress(jobId, 90);

      // Store transcript
      const transcriptKey = `transcripts/${jobId}.txt`;
      await this.storageService.uploadContent(transcriptKey, transcription, 'text/plain');

      // Mark as completed
      const preview = transcription.substring(0, 150) + (transcription.length > 150 ? '...' : '');
      await this.jobsService.markCompleted(jobId, transcriptKey, preview, transcription);

      // Clean up: delete processed audio file
      try {
        await this.storageService.deleteObject(job.objectKey);
        this.logger.info('Cleaned up processed audio file', { 
          jobId, 
          objectKey: job.objectKey
        });
      } catch (cleanupError) {
        // Don't fail the job if cleanup fails
        const errorMessage = cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup error';
        this.logger.warn('Failed to clean up audio file', {
          jobId,
          objectKey: job.objectKey,
          error: errorMessage
        });
      }

      this.logger.info('Job completed successfully', { 
        jobId, 
        transcriptionLength: transcription.length 
      });

    } catch (error) {
      this.logger.error('Job processing failed', { 
        jobId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });

      // Mark as failed
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.jobsService.markFailed(jobId, 'TRANSCRIPTION_ERROR', errorMessage);

      throw error;
    }
  }

  /**
   * Create and enqueue a new transcription job
   */
  async createJob(params: {
    audioBuffer: ArrayBuffer;
    fileName: string;
    source: 'web' | 'telegram';
    meta?: Record<string, any>;
  }): Promise<{ jobId: string; estimatedDuration: number }> {
    this.logger.info('Creating transcription job', { 
      fileName: params.fileName,
      fileSize: params.audioBuffer.byteLength,
      source: params.source
    });

    // Validate file size (business rule)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (params.audioBuffer.byteLength > maxSize) {
      throw new Error(`File size ${params.audioBuffer.byteLength} exceeds maximum of ${maxSize} bytes`);
    }

    // Store the audio file
    const objectKey = `audio/${crypto.randomUUID()}-${params.fileName}`;
    await this.storageService.uploadContent(
      objectKey, 
      params.audioBuffer, 
      this.guessMimeType(params.fileName)
    );

    // Create the job record
    const jobId = await this.jobsService.createJob({
      objectKey,
      fileName: params.fileName,
      source: params.source as any,
      meta: params.meta || {}
    });

    // Enqueue job for processing
    if (this.queue) {
      try {
        await this.queue.send({
          jobId,
          objectKey,
          fileName: params.fileName,
          source: params.source,
          meta: params.meta || {}
        });
        
        this.logger.info('Job enqueued successfully', {
          jobId,
          objectKey,
          queueName: 'transcribe'
        });
      } catch (queueError) {
        this.logger.error('Failed to enqueue job', {
          jobId,
          error: queueError instanceof Error ? queueError.message : 'Unknown queue error'
        });
        
        // Mark job as failed since we couldn't queue it
        await this.jobsService.markFailed(jobId, 'QUEUE_ERROR', 'Failed to enqueue job for processing');
        throw new Error('Failed to enqueue transcription job');
      }
    } else {
      this.logger.warn('Queue not configured, job created but not enqueued', {
        jobId
      });
    }

    // Estimate processing time (simple heuristic)
    const fileSizeMB = params.audioBuffer.byteLength / (1024 * 1024);
    const estimatedDuration = Math.max(5, fileSizeMB * 2); // 2 seconds per MB, minimum 5 seconds

    this.logger.info('Transcription job created and queued', { 
      jobId, 
      objectKey, 
      estimatedDuration 
    });

    return { jobId, estimatedDuration };
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop();
    switch (ext) {
      case 'm4a': return 'audio/m4a';
      case 'mp3': return 'audio/mpeg';
      case 'wav': return 'audio/wav';
      case 'ogg': return 'audio/ogg';
      default: return 'audio/m4a';
    }
  }
}