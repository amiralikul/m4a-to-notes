/**
 * Queue Consumer for Transcription Processing
 * Handles async transcription jobs from Cloudflare Queues
 */

import { transcribeAudio } from './transcription.js';
import { StorageService } from './storage.js';
import { JobsService } from './jobs.js';
import { sendTelegramMessage } from './telegram.js';
import { UsersService } from './users.js';
import { 
  SUBSCRIPTION_PLANS, 
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDERS,
  QUEUE_MESSAGE_TYPES,
  WEBHOOK_EVENT_TYPES,
  mapPaddleStatus,
  mapPaddlePriceToPlan,
  getPlanHierarchyValue
} from '../constants/plans.js';

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
 * Paddle Webhook Queue Consumer
 * Handles async processing of Paddle webhook events
 */
export class PaddleWebhookQueueConsumer {
  constructor(env, logger) {
    this.env = env;
    this.logger = logger;
    this.users = new UsersService(env.ENTITLEMENTS, logger);
  }

  /**
   * Process a Paddle webhook event from the queue
   * @param {Object} message - Queue message
   * @param {string} message.eventId - Paddle event ID
   * @param {string} message.eventType - Event type
   * @param {Object} message.subscription - Subscription data
   * @param {string} message.requestId - Request ID for tracing
   */
  async processPaddleWebhook(message) {
    const { eventId, eventType, subscription, requestId } = message;
    
    this.logger.info('Processing Paddle webhook from queue', {
      eventId,
      eventType,
      subscriptionId: subscription?.id,
      requestId
    });

    try {
      // Process the subscription event
      await this.syncEntitlements(subscription, eventType, requestId);
      
      this.logger.info('Paddle webhook processed successfully from queue', {
        eventId,
        eventType,
        subscriptionId: subscription?.id,
        requestId
      });

    } catch (error) {
      this.logger.error('Paddle webhook queue processing failed', {
        eventId,
        eventType,
        subscriptionId: subscription?.id,
        requestId,
        error: error.message,
        stack: error.stack
      });

      throw error;
    }
  }

  /**
   * Sync subscription data to entitlements (moved from paddle.js handler)
   */
  async syncEntitlements(subscription, eventType, requestId) {
    // Extract userId from custom_data
    const userId = subscription.custom_data?.clerkUserId;
    
    if (!userId) {
      this.logger.warn('No clerkUserId in custom_data, skipping sync', {
        requestId,
        subscriptionId: subscription.id
      });
      return;
    }
    
    // Map subscription to plan and status
    let plan = SUBSCRIPTION_PLANS.FREE;
    let status = SUBSCRIPTION_STATUS.NONE;
    
    if (eventType === WEBHOOK_EVENT_TYPES.SUBSCRIPTION_CANCELED) {
      plan = SUBSCRIPTION_PLANS.FREE;
      status = SUBSCRIPTION_STATUS.CANCELED;
    } else {
      // Map subscription status using utility function
      status = mapPaddleStatus(subscription.status);

      // Map subscription items to plan
      if (subscription.items && subscription.items.length > 0) {
        const priceId = subscription.items[0].price?.id;
        
        plan = mapPaddlePriceToPlan(priceId, this.env.BUSINESS_PRICE_ID);
      }
    }
    
    // Prepare metadata
    const meta = {
      subscriptionId: subscription.id,
      customerId: subscription.customer_id,
      currency: subscription.currency_code || 'USD',
      name: subscription.items?.[0]?.name || 'Unknown',
      priceId: subscription.items?.[0]?.price?.id || 'Unknown',
    };
    
    if (subscription.items?.[0]?.price) {
      meta.unitPrice = subscription.items[0].price.unit_price?.amount;
    }
    
    if (subscription.current_billing_period?.ends_at) {
      meta.periodEnd = subscription.current_billing_period.ends_at;
    }
    
    // Check for subscription conflicts before updating entitlements
    const existingEntitlements = await this.users.get(userId);
    
    // Detect multiple active subscriptions conflict
    const hasActiveExisting = existingEntitlements && 
      [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING].includes(existingEntitlements.status) &&
      existingEntitlements.meta?.subscriptionId !== subscription.id;
      
    const hasActiveNew = [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING].includes(status);
    
    if (hasActiveExisting && hasActiveNew) {
      this.logger.warn('Multiple active subscriptions detected for user', {
        requestId,
        userId,
        existingSubscription: existingEntitlements.meta?.subscriptionId,
        newSubscription: subscription.id,
        existingPlan: existingEntitlements.plan,
        newPlan: plan
      });
      
      // Conflict resolution: keep higher-value subscription
      const existingValue = getPlanHierarchyValue(existingEntitlements.plan);
      const newValue = getPlanHierarchyValue(plan);
      
      if (newValue <= existingValue) {
        this.logger.info('Keeping existing higher-value subscription, skipping update', {
          requestId,
          userId,
          keptPlan: existingEntitlements.plan,
          skippedPlan: plan
        });
        
        return existingEntitlements; // Don't update, keep existing
      } else {
        this.logger.info('New subscription has higher value, updating entitlements', {
          requestId,
          userId,
          previousPlan: existingEntitlements.plan,
          newPlan: plan
        });
      }
    }
    
    // Update entitlements in KV
    const entitlements = await this.users.set(userId, {
      plan,
      status,
      provider: SUBSCRIPTION_PROVIDERS.PADDLE,
      meta
    });
    
    this.logger.info('Entitlements synced from queued webhook', {
      requestId,
      userId,
      plan: entitlements.plan,
      status: entitlements.status,
      subscriptionId: subscription.id
    });
  }
}

/**
 * Queue consumer handler for Cloudflare Workers
 * This function will be called by the Cloudflare Workers runtime for each queued message
 */
export async function handleQueueMessage(batch, env) {
  const logger = new (await import('../logger.js')).default(env.LOG_LEVEL || 'INFO');
  const transcriptionConsumer = new TranscriptionQueueConsumer(env, logger);
  const paddleConsumer = new PaddleWebhookQueueConsumer(env, logger);

  // Process each message in the batch
  for (const message of batch.messages) {
    try {
      const messageData = message.body;
      
      logger.info('Processing queue message', {
        messageId: message.id,
        messageType: messageData.type || 'transcription',
        jobId: messageData.jobId,
        eventId: messageData.eventId,
        attempts: message.attempts
      });

      // Route message to appropriate consumer based on type
      if (messageData.type === QUEUE_MESSAGE_TYPES.PADDLE_WEBHOOK) {
        await paddleConsumer.processPaddleWebhook(messageData);
      } else {
        // Default to transcription job processing
        await transcriptionConsumer.processTranscriptionJob(messageData);
      }
      
      // Acknowledge successful processing
      message.ack();
      
    } catch (error) {
      logger.error('Queue message processing failed', {
        messageId: message.id,
        messageType: messageData?.type || 'transcription',
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
          messageType: messageData?.type || 'transcription',
          jobId: messageData?.jobId,
          eventId: messageData?.eventId
        });
        message.ack(); // Remove from queue after max retries
      }
    }
  }
}