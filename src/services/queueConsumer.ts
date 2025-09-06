/**
 * Queue Consumer for Transcription Processing
 * Handles async transcription jobs from Cloudflare Queues
 * Note: Paddle webhook processing removed - now handled synchronously with canonical state fetching
 */

import { sendTelegramMessage } from './telegram.js';
import { TranscriptionOrchestrator } from './transcriptionOrchestrator.js';
import { createServices } from './serviceFactory.js';
import Logger from '../logger.js';

// Type and type guard for queue messages
export type TranscriptionQueueMessage = {
  eventType: 'transcription.requested';
  transcriptionId: string;
};

export type TranscriptionMessage = {
  id: string;
  body: TranscriptionQueueMessage;
  attempts: number;
};

// // Cloudflare Workers types for queue handling
// interface MessageBatch {
//   messages: Array<{
//     id: string;
//     body: any;
//     attempts: number;
//   }>;
// }

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
   * Process a transcription event from the queue
   * @param {Object} queueMessage - Minimal queue message containing transcription event
   */
  async processTranscriptionEvent(queueMessage: TranscriptionQueueMessage) {
    const { eventType, transcriptionId } = queueMessage;

    if (!transcriptionId) {
      throw new Error('Queue message missing required transcriptionId');
    }

    if (eventType !== 'transcription.requested') {
      throw new Error(`Unsupported event type: ${eventType}`);
    }

    this.logger.info('Processing transcription event from queue', { 
      eventType,
      transcriptionId 
    });

    // Fetch full transcription details from database (single source of truth)
    const services = createServices(this.env, this.logger);
    const transcription = await services.transcriptionsService.findById(transcriptionId);
    
    if (!transcription) {
      throw new Error(`Transcription not found in database: ${transcriptionId}`);
    }

    // Extract transcription details from database record
    const { filename, source, userMetadata } = transcription;
    const metadata = userMetadata || {};
    const requestId = metadata.requestId;
    const userId = metadata.userId;
    const telegramChatId = metadata.telegramChatId;

    this.logger.info('Fetched transcription details from database', {
      transcriptionId,
      filename,
      source,
      userId,
      telegramChatId,
      requestId
    });

    try {
      // Delegate core transcription processing to orchestrator
      await this.orchestrator.processTranscription(transcriptionId);

      // Get the transcription result to check status
      const processedTranscription = await services.transcriptionsService.findById(transcriptionId);
      
      if (!processedTranscription) {
        throw new Error('Transcription record not found after processing');
      }

      // Check if transcription failed during processing
      if (processedTranscription.status === 'failed') {
        const errorMessage = processedTranscription.errorDetails?.message || 'Transcription failed during processing';
        throw new Error(`Transcription failed: ${errorMessage}`);
      }

      // Check if transcription completed successfully
      if (processedTranscription.status !== 'completed') {
        throw new Error(`Transcription in unexpected status: ${processedTranscription.status}`);
      }

      if (!processedTranscription.transcriptText) {
        throw new Error('Transcription marked completed but transcript text is missing');
      }

      this.logger.info('Transcription completed successfully via orchestrator', {
        transcriptionId,
        transcriptionLength: processedTranscription.transcriptText.length,
        requestId
      });

      // Send result to user via Telegram (transport-specific logic)
      if (telegramChatId && this.env.TELEGRAM_BOT_TOKEN) {
        await this.sendTranscriptionToTelegram(
          telegramChatId, 
          processedTranscription.transcriptText, 
          filename, 
          transcriptionId
        );
      }

      return processedTranscription;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      this.logger.error('Transcription processing failed', {
        transcriptionId,
        userId,
        error: errorMessage,
        stack: errorStack,
        requestId
      });

      // Send error notification to user (transport-specific logic)
      if (telegramChatId && this.env.TELEGRAM_BOT_TOKEN) {
        await this.sendErrorToTelegram(telegramChatId, errorMessage, filename, transcriptionId);
      }

      throw error;
    }
  }

  /**
   * Send transcription result to Telegram user
   */
  private async sendTranscriptionToTelegram(chatId: string, transcriptionText: string, filename: string, transcriptionId: string) {
    try {
      const message = `🎯 **Transcription Complete**\n\n📁 **File:** ${filename}\n\n📝 **Transcript:**\n\n${transcriptionText}`;
      
      await sendTelegramMessage(chatId, message, this.env.TELEGRAM_BOT_TOKEN);

      this.logger.info('Transcription sent to Telegram user', {
        transcriptionId,
        chatId,
        transcriptionLength: transcriptionText.length
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to send transcription to Telegram', {
        transcriptionId,
        chatId,
        error: errorMessage
      });
      // Don't re-throw - transcription succeeded, notification failure shouldn't fail the transcription
    }
  }

  /**
   * Send error notification to Telegram user
   */
  private async sendErrorToTelegram(chatId: string, errorMessage: string, filename: string, transcriptionId: string) {
    try {
      const message = `❌ **Transcription Failed**\n\n📁 **File:** ${filename}\n\n💥 **Error:** ${errorMessage}\n\nPlease try again or contact support if the problem persists.`;
      
      await sendTelegramMessage(chatId, message, this.env.TELEGRAM_BOT_TOKEN);

      this.logger.info('Error notification sent to Telegram user', {
        transcriptionId,
        chatId,
        error: errorMessage
      });

    } catch (notificationError) {
      const notifErrorMessage = notificationError instanceof Error ? notificationError.message : 'Unknown error';
      this.logger.error('Failed to send error notification to Telegram', {
        transcriptionId,
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
export async function handleQueueMessage(batch: MessageBatch<TranscriptionQueueMessage>, env: Env, _ctx?: ExecutionContext) {
  const logger = new (await import('../logger.js')).default(env.LOG_LEVEL || 'INFO');
  const transcriptionConsumer = new TranscriptionQueueConsumer(env, logger);

  // Process each message in the batch
  for (const message of batch.messages) {
    try {
      const messageData = message.body;
      
      logger.info('Processing queue message', {
        messageId: message.id,
        eventType: messageData.eventType,
        transcriptionId: messageData.transcriptionId,
        attempts: message.attempts
      });

      // All messages are now transcription events (Paddle webhooks handled synchronously)
      // Pass the minimal queue message - transcription details will be fetched from DB
      await transcriptionConsumer.processTranscriptionEvent(messageData);
      
      logger.info('Queue message processed successfully', {
        messageId: message.id,
        transcriptionId: messageData.transcriptionId
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