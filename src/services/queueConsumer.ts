/**
 * Queue Consumer for Transcription Processing
 * Handles async transcription jobs from Cloudflare Queues
 * Note: Paddle webhook processing removed - now handled synchronously with canonical state fetching
 */

import { sendTelegramMessage } from './telegram.js';
import { TranscriptionOrchestrator } from './transcriptionOrchestrator.js';
import { createServices } from './serviceFactory.js';
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
  private orchestrator: TranscriptionOrchestrator;

  constructor(env: Env, logger: Logger) {
    this.env = env;
    this.logger = logger;
    
    // Use service factory to create orchestrator with all dependencies
    const services = createServices(env, logger);
    this.orchestrator = services.transcriptionOrchestrator;
  }

  /**
   * Process a transcription job from the queue
   * @param {Object} job - Job object from queue
   */
  async processTranscriptionJob(job: any) {
    const { jobId, userId, telegramChatId, fileName, source, meta = {} } = job;
    const requestId = meta.requestId;

    this.logger.info('Processing transcription job from queue', {
      jobId,
      userId,
      telegramChatId,
      requestId
    });

    try {
      // Delegate core transcription processing to orchestrator
      await this.orchestrator.processJob(jobId);

      // Get the completed job to access transcription result
      const services = createServices(this.env, this.logger);
      const completedJob = await services.jobsService.getJob(jobId);
      
      if (!completedJob || !completedJob.transcription) {
        throw new Error('Job completed but transcription not found');
      }

      this.logger.info('Transcription completed successfully via orchestrator', {
        jobId,
        transcriptionLength: completedJob.transcription.length,
        requestId
      });

      // Send result to user via Telegram (transport-specific logic)
      if (telegramChatId && this.env.TELEGRAM_BOT_TOKEN) {
        await this.sendTranscriptionToTelegram(
          telegramChatId, 
          completedJob.transcription, 
          fileName, 
          jobId
        );
      }

      return completedJob;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      this.logger.error('Transcription job failed', {
        jobId,
        userId,
        error: errorMessage,
        stack: errorStack,
        requestId
      });

      // Send error notification to user (transport-specific logic)
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