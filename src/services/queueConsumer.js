/**
 * Queue Consumer for Transcription Processing
 * Handles async transcription jobs from Cloudflare Queues
 */

import { transcribeAudio } from './transcription.js';
import { StorageService } from './storage.js';
import { JobsService, JobStatus } from './jobs.js';
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
   * @param {Object} message - Queue message
   * @param {string} message.jobId - Job ID
   * @param {string} message.objectKey - R2 object key for audio file
   * @param {string} message.fileName - Original filename
   * @param {string} message.source - Job source (web/telegram)
   * @param {Object} message.meta - Additional metadata
   */
  async processTranscriptionJob(message) {
    const { jobId, objectKey, fileName, source, meta } = message;
    
    this.logger.info('Processing transcription job', {
      jobId,
      objectKey,
      fileName,
      source
    });

    try {
      // Step 1: Mark job as processing
      await this.jobs.markProcessing(jobId, 10);

      // Step 2: Download audio file from R2
      this.logger.info('Downloading audio file from R2', { jobId, objectKey });
      const audioBuffer = await this.storage.downloadContent(objectKey);
      
      await this.jobs.updateProgress(jobId, 30);

      // Step 3: Transcribe audio using OpenAI Whisper
      this.logger.info('Starting transcription', { jobId, fileName });
      const transcription = await transcribeAudio(
        audioBuffer, 
        this.env.OPENAI_API_KEY, 
        this.logger
      );

      if (!transcription || !transcription.trim()) {
        throw new Error('No speech detected in audio file');
      }

      await this.jobs.updateProgress(jobId, 80);

      // Step 4: Store transcript in R2
      const transcriptKey = this.storage.generateTranscriptKey(jobId);
      await this.storage.uploadContent(
        transcriptKey, 
        new TextEncoder().encode(transcription),
        'text/plain'
      );

      await this.jobs.updateProgress(jobId, 95);

      // Step 5: Mark job as completed
      const transcriptPreview = transcription.length > 200 
        ? transcription.substring(0, 200) + '...' 
        : transcription;

      await this.jobs.markCompleted(jobId, transcriptKey, transcriptPreview);

      // Step 6: Handle source-specific notifications
      if (source === 'telegram' && meta?.telegramChatId) {
        await this.sendTelegramNotification(meta.telegramChatId, transcription, fileName);
      }

      this.logger.info('Transcription job completed successfully', {
        jobId,
        transcriptionLength: transcription.length,
        fileName
      });

    } catch (error) {
      this.logger.error('Transcription job failed', {
        jobId,
        objectKey,
        fileName,
        error: error.message,
        stack: error.stack
      });

      // Mark job as failed
      await this.jobs.markFailed(
        jobId, 
        error.name || 'TRANSCRIPTION_ERROR',
        error.message
      );

      // Send error notification for Telegram users
      if (source === 'telegram' && meta?.telegramChatId) {
        await this.sendTelegramError(meta.telegramChatId, error.message, fileName);
      }

      throw error;
    }
  }

  /**
   * Send transcription result to Telegram user
   * @param {string} chatId - Telegram chat ID
   * @param {string} transcription - Transcription text
   * @param {string} fileName - Original filename
   */
  async sendTelegramNotification(chatId, transcription, fileName) {
    try {
      const message = `🎵 *Transcription Complete*\n\n` +
        `📁 *File:* ${fileName}\n\n` +
        `📝 *Transcript:*\n${transcription}`;

      // If message is too long for Telegram (4096 char limit), send as file
      if (message.length > 4000) {
        await sendTelegramMessage(
          chatId,
          `🎵 *Transcription Complete*\n\n📁 *File:* ${fileName}\n\n` +
          `📝 The transcript is too long for a message. Here's a preview:\n\n` +
          `${transcription.substring(0, 500)}...\n\n` +
          `_Full transcript available via web interface_`,
          this.env.TELEGRAM_BOT_TOKEN
        );
      } else {
        await sendTelegramMessage(
          chatId,
          message,
          this.env.TELEGRAM_BOT_TOKEN
        );
      }

      this.logger.info('Telegram notification sent', { chatId, fileName });
    } catch (error) {
      this.logger.error('Failed to send Telegram notification', {
        chatId,
        fileName,
        error: error.message
      });
    }
  }

  /**
   * Send error notification to Telegram user
   * @param {string} chatId - Telegram chat ID
   * @param {string} errorMessage - Error message
   * @param {string} fileName - Original filename
   */
  async sendTelegramError(chatId, errorMessage, fileName) {
    try {
      const message = `❌ *Transcription Failed*\n\n` +
        `📁 *File:* ${fileName}\n\n` +
        `💬 *Error:* ${errorMessage}\n\n` +
        `Please try uploading the file again or contact support if the issue persists.`;

      await sendTelegramMessage(
        chatId,
        message,
        this.env.TELEGRAM_BOT_TOKEN
      );

      this.logger.info('Telegram error notification sent', { chatId, fileName });
    } catch (error) {
      this.logger.error('Failed to send Telegram error notification', {
        chatId,
        fileName,
        error: error.message
      });
    }
  }
}

/**
 * Queue consumer handler for Cloudflare Workers
 * This function will be called by the Cloudflare Workers runtime for each queued message
 */
export async function handleQueueMessage(batch, env, ctx) {
  const logger = new (await import('../logger.js')).default(env.LOG_LEVEL || 'INFO');
  const consumer = new TranscriptionQueueConsumer(env, logger);

  // Process each message in the batch
  for (const message of batch.messages) {
    try {
      const messageData = message.body;
      
      logger.info('Processing queue message', {
        messageId: message.id,
        jobId: messageData.jobId,
        attempts: message.attempts
      });

      await consumer.processTranscriptionJob(messageData);
      
      // Acknowledge successful processing
      message.ack();
      
    } catch (error) {
      logger.error('Queue message processing failed', {
        messageId: message.id,
        attempts: message.attempts,
        error: error.message,
        stack: error.stack
      });

      // Retry logic: retry up to 3 times with exponential backoff
      if (message.attempts < 3) {
        message.retry({ delaySeconds: Math.pow(2, message.attempts) * 30 }); // 30s, 60s, 120s
      } else {
        // Max retries reached, send to dead letter queue or acknowledge to remove
        logger.error('Max retries reached for message', {
          messageId: message.id,
          jobId: messageData?.jobId
        });
        message.ack(); // Remove from queue after max retries
      }
    }
  }
}