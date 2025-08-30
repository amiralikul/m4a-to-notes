/**
 * Queue Consumer for Transcription Processing
 * Handles async transcription jobs from Cloudflare Queues
 * Note: Paddle webhook processing removed - now handled synchronously with canonical state fetching
 */

import { transcribeAudio } from './transcription.js';
import { StorageService } from './storage.js';
import { JobsService } from './jobs.js';
import { sendTelegramMessage } from './telegram.js';
import { createDatabase } from '../db/index.js';
import Logger from '../logger.js';

// Cloudflare Workers types for queue handling
interface MessageBatch {
  messages: Array<{
    id: string;
    body: any;
    attempts: number;
  }>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}
export class TranscriptionQueueConsumer {
  private env: Env;
  private logger: Logger;
  private storage: StorageService;
  private jobs: JobsService;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
    this.storage = new StorageService(env.M4A_BUCKET, logger, env);
    const db = createDatabase(env, logger);
    this.jobs = new JobsService(db, logger);
  }

  /**
   * Process a transcription job from the queue
   * @param {Object} job - Job object from queue
   */
  async processTranscriptionJob(job: any) {
    const { jobId, userId, telegramChatId, objectKey, fileName, source, meta = {} } = job;
    const requestId = meta.requestId;

    this.logger.info('Processing transcription job from queue', {
      jobId,
      userId,
      telegramChatId,
      objectKey,
      requestId
    });

    try {
      // Update job status to processing
      await this.jobs.updateJob(jobId, {
        status: 'processing'
      });

      // Download audio file from R2
      this.logger.info('Downloading audio file for transcription', { 
        jobId, 
        objectKey, 
        requestId 
      });
      
      const audioBuffer = await this.storage.downloadContent(objectKey);
      if (!audioBuffer) {
        throw new Error(`Audio file not found: ${objectKey}`);
      }

      // Transcribe using OpenAI Whisper
      this.logger.info('Starting transcription with OpenAI Whisper', { 
        jobId, 
        fileName, 
        requestId 
      });
      
      const transcription = await transcribeAudio(audioBuffer, this.env.OPENAI_API_KEY, this.logger);
      
      if (!transcription || typeof transcription !== 'string') {
        throw new Error('Transcription failed - no text returned');
      }

      const transcriptText = transcription.trim();
      
      // Update job with completed status and store transcription in meta
      const completedJob = await this.jobs.updateJob(jobId, {
        status: 'completed',
        meta: meta,
        transcription: transcriptText
      });

      this.logger.info('Transcription completed successfully', {
        jobId,
        transcriptionLength: transcriptText.length,
        requestId
      });

      // Send result to user via Telegram
      if (telegramChatId && this.env.TELEGRAM_BOT_TOKEN) {
        await this.sendTranscriptionToTelegram(
          telegramChatId, 
          transcriptText, 
          fileName, 
          jobId
        );
      }

      // Clean up: delete processed file from R2
      try {
        await this.storage.deleteObject(objectKey);
        this.logger.info('Cleaned up processed audio file', { 
          jobId, 
          objectKey, 
          requestId 
        });
      } catch (cleanupError) {
        // Don't fail the job if cleanup fails
        const errorMessage = cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup error';
        this.logger.warn('Failed to clean up audio file', {
          jobId,
          objectKey,
          error: errorMessage,
          requestId
        });
      }

      return completedJob;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      this.logger.error('Transcription job failed', {
        jobId,
        userId,
        objectKey,
        error: errorMessage,
        stack: errorStack,
        requestId
      });

      // Update job status to error
      await this.jobs.updateJob(jobId, {
        status: 'error',
        errorMessage: errorMessage
      });

      // Send error notification to user
      if (telegramChatId && this.env.TELEGRAM_BOT_TOKEN) {
        await this.sendErrorToTelegram(telegramChatId, errorMessage, fileName, jobId);
      }

      throw error;
    }
  }

  /**
   * Send transcription result to Telegram user
   */
  private async sendTranscriptionToTelegram(chatId: string, transcriptionText: string, fileName: string, jobId: string) {
    try {
      const message = `🎯 **Transcription Complete**\n\n📁 **File:** ${fileName}\n\n📝 **Transcript:**\n\n${transcriptionText}`;
      
      await sendTelegramMessage(chatId, message, this.env.TELEGRAM_BOT_TOKEN);

      this.logger.info('Transcription sent to Telegram user', {
        jobId,
        chatId,
        transcriptionLength: transcriptionText.length
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to send transcription to Telegram', {
        jobId,
        chatId,
        error: errorMessage
      });
      // Don't re-throw - transcription succeeded, notification failure shouldn't fail the job
    }
  }

  /**
   * Send error notification to Telegram user
   */
  private async sendErrorToTelegram(chatId: string, errorMessage: string, fileName: string, jobId: string) {
    try {
      const message = `❌ **Transcription Failed**\n\n📁 **File:** ${fileName}\n\n💥 **Error:** ${errorMessage}\n\nPlease try again or contact support if the problem persists.`;
      
      await sendTelegramMessage(chatId, message, this.env.TELEGRAM_BOT_TOKEN);

      this.logger.info('Error notification sent to Telegram user', {
        jobId,
        chatId,
        error: errorMessage
      });

    } catch (notificationError) {
      const notifErrorMessage = notificationError instanceof Error ? notificationError.message : 'Unknown error';
      this.logger.error('Failed to send error notification to Telegram', {
        jobId,
        chatId,
        originalError: errorMessage,
        notificationError: notifErrorMessage
      });
    }
  }
}

/**
 * Queue consumer handler for Cloudflare Workers
 * This function will be called by the Cloudflare Workers runtime for each queued message
 * Note: Only handles transcription jobs now - Paddle webhooks processed synchronously
 */
export async function handleQueueMessage(batch: MessageBatch, env: Env, _ctx?: ExecutionContext) {
  const logger = new (await import('../logger.js')).default(env.LOG_LEVEL || 'INFO');
  const transcriptionConsumer = new TranscriptionQueueConsumer(env, logger);

  // Process each message in the batch
  for (const message of batch.messages) {
    try {
      const messageData = message.body;
      
      logger.info('Processing queue message', {
        messageId: message.id,
        jobId: messageData.jobId,
        attempts: message.attempts
      });

      // All messages are now transcription jobs (Paddle webhooks handled synchronously)
      await transcriptionConsumer.processTranscriptionJob(messageData);
      
      logger.info('Queue message processed successfully', {
        messageId: message.id,
        jobId: messageData.jobId
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      logger.error('Queue message processing failed', {
        messageId: message.id,
        attempts: message.attempts,
        error: errorMessage,
        stack: errorStack
      });

      // Re-throw to trigger queue retry mechanism
      throw error;
    }
  }
}