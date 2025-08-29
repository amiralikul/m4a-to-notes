/**
 * Queue Consumer for Transcription Processing
 * Handles async transcription jobs from Cloudflare Queues
 * Note: Paddle webhook processing removed - now handled synchronously with canonical state fetching
 */

import { transcribeAudio } from './transcription.js';
import { StorageService } from './storage.js';
import { JobsService } from './jobs.js';
import { sendTelegramMessage } from './telegram.js';

export class TranscriptionQueueConsumer {
  constructor(env, logger) {
    this.env = env;
    this.logger = logger;
    this.storage = new StorageService(env.M4A_BUCKET, logger, env);
    this.jobs = new JobsService(env.JOBS, logger);
  }

  /**
   * Process a transcription job from the queue
   * @param {Object} job - Job object from queue
   */
  async processTranscriptionJob(job) {
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
        status: 'processing', 
        startedAt: new Date().toISOString() 
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
      
      // Update job with completed status and result
      const completedJob = await this.jobs.updateJob(jobId, {
        status: 'completed',
        result: { transcription: transcriptText },
        completedAt: new Date().toISOString()
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
        this.logger.warn('Failed to clean up audio file', {
          jobId,
          objectKey,
          error: cleanupError.message,
          requestId
        });
      }

      return completedJob;

    } catch (error) {
      this.logger.error('Transcription job failed', {
        jobId,
        userId,
        objectKey,
        error: error.message,
        stack: error.stack,
        requestId
      });

      // Update job status to failed
      await this.jobs.updateJob(jobId, {
        status: 'failed',
        error: error.message,
        failedAt: new Date().toISOString()
      });

      // Send error notification to user
      if (telegramChatId && this.env.TELEGRAM_BOT_TOKEN) {
        await this.sendErrorToTelegram(telegramChatId, error.message, fileName, jobId);
      }

      throw error;
    }
  }

  /**
   * Send transcription result to Telegram user
   */
  async sendTranscriptionToTelegram(chatId, transcriptionText, fileName, jobId) {
    try {
      const message = `🎯 **Transcription Complete**\n\n📁 **File:** ${fileName}\n\n📝 **Transcript:**\n\n${transcriptionText}`;
      
      await sendTelegramMessage(chatId, message, this.env.TELEGRAM_BOT_TOKEN);

      this.logger.info('Transcription sent to Telegram user', {
        jobId,
        chatId,
        transcriptionLength: transcriptionText.length
      });

    } catch (error) {
      this.logger.error('Failed to send transcription to Telegram', {
        jobId,
        chatId,
        error: error.message
      });
      // Don't re-throw - transcription succeeded, notification failure shouldn't fail the job
    }
  }

  /**
   * Send error notification to Telegram user
   */
  async sendErrorToTelegram(chatId, errorMessage, fileName, jobId) {
    try {
      const message = `❌ **Transcription Failed**\n\n📁 **File:** ${fileName}\n\n💥 **Error:** ${errorMessage}\n\nPlease try again or contact support if the problem persists.`;
      
      await sendTelegramMessage(chatId, message, this.env.TELEGRAM_BOT_TOKEN);

      this.logger.info('Error notification sent to Telegram user', {
        jobId,
        chatId,
        error: errorMessage
      });

    } catch (notificationError) {
      this.logger.error('Failed to send error notification to Telegram', {
        jobId,
        chatId,
        originalError: errorMessage,
        notificationError: notificationError.message
      });
    }
  }
}

/**
 * Queue consumer handler for Cloudflare Workers
 * This function will be called by the Cloudflare Workers runtime for each queued message
 * Note: Only handles transcription jobs now - Paddle webhooks processed synchronously
 */
export async function handleQueueMessage(batch, env) {
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
      logger.error('Queue message processing failed', {
        messageId: message.id,
        attempts: message.attempts,
        error: error.message,
        stack: error.stack
      });

      // Re-throw to trigger queue retry mechanism
      throw error;
    }
  }
}