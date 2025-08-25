import { UsersService } from '../services/users.js';
import { 
  WEBHOOK_EVENT_TYPES,
  QUEUE_MESSAGE_TYPES,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDERS,
  mapPaddleStatus,
  mapPaddlePriceToPlan,
  getPlanHierarchyValue
} from '../constants/plans.js';

/**
 * Verify Paddle webhook signature using Web Crypto API
 * @param {string} body - Raw request body
 * @param {string} signature - Paddle signature header
 * @param {string} secret - Webhook secret
 * @returns {Promise<boolean>}
 */
async function verifyWebhookSignature(body, signature, secret) {
  if (!signature || !secret) return false;
  
  try {
    // Extract timestamp and signature from header
    const parts = signature.split(';');
    let ts, h1;
    
    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 'ts') ts = value;
      if (key === 'h1') h1 = value;
    }
    
    if (!ts || !h1) return false;
    
    // Create expected signature using Web Crypto API
    const payload = `${ts}:${body}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(payload);
    
    // Import the key for HMAC
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    // Generate signature
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, messageData);
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    // Compare signatures (constant time comparison)
    return h1 === expectedSignature;
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Handle Paddle webhook events
 * POST /api/webhook
 */
/**
 * Timeout wrapper for webhook processing
 * @param {Promise} promise - Promise to wrap with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise} Promise that resolves or rejects with timeout
 */
function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Webhook processing timeout')), timeoutMs);
    })
  ]);
}

export async function handlePaddleWebhook(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    // Wrap entire webhook processing with 4-second timeout
    return await withTimeout(processWebhook(c), 4000);
  } catch (error) {
    if (error.message === 'Webhook processing timeout') {
      logger.error('Webhook processing timed out after 4 seconds', {
        requestId,
        error: error.message
      });
      
      return c.json({ 
        error: 'Webhook processing timeout',
        requestId 
      }, 500);
    }
    
    logger.error('Webhook processing failed', {
      requestId,
      error: error.message,
      stack: error.stack
    });
    
    return c.json({ 
      error: 'Webhook processing failed',
      requestId 
    }, 500);
  }
}

async function processWebhook(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  const body = await c.req.text();
  const signature = c.req.header('paddle-signature');
  
  logger.info('Received Paddle webhook', { 
    requestId,
    hasSignature: !!signature
  });

  // Verify webhook signature (uncomment for production)
  // const webhookSecret = c.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
  // if (webhookSecret && !(await verifyWebhookSignature(body, signature, webhookSecret))) {
  //   logger.warn('Invalid webhook signature', { requestId });
  //   return c.json({ error: 'Invalid signature' }, 401);
  // }

  const event = JSON.parse(body);
  
  logger.info('Processing webhook event', {
    requestId,
    eventType: event.event_type,
    eventId: event.event_id
  });

    // Handle different event types - use queue for async processing
    try {
      // For subscription events, queue the processing to respond quickly
      if ([WEBHOOK_EVENT_TYPES.SUBSCRIPTION_CREATED, WEBHOOK_EVENT_TYPES.SUBSCRIPTION_UPDATED, WEBHOOK_EVENT_TYPES.SUBSCRIPTION_CANCELED].includes(event.event_type)) {
        
        // Queue entitlement sync for background processing
        if (c.env.QUEUE) {
          await c.env.QUEUE.send({
            type: QUEUE_MESSAGE_TYPES.PADDLE_WEBHOOK,
            eventId: event.event_id,
            eventType: event.event_type,
            subscription: event.data,
            requestId,
            timestamp: new Date().toISOString()
          });
          
          logger.info('Queued webhook event for background processing', {
            requestId,
            eventId: event.event_id,
            eventType: event.event_type
          });
        } else {
          // Fallback to synchronous processing if queue not available
          logger.warn('QUEUE not configured, processing webhook synchronously', {
            requestId,
            eventType: event.event_type
          });
          
          switch (event.event_type) {
            case WEBHOOK_EVENT_TYPES.SUBSCRIPTION_CREATED:
              await handleSubscriptionCreated(c, event.data);
              break;
            case WEBHOOK_EVENT_TYPES.SUBSCRIPTION_UPDATED:
              await handleSubscriptionUpdated(c, event.data);
              break;
            case WEBHOOK_EVENT_TYPES.SUBSCRIPTION_CANCELED:
              await handleSubscriptionCanceled(c, event.data);
              break;
          }
        }
      } else {
        // Handle non-subscription events synchronously (they're usually fast)
        switch (event.event_type) {
          case WEBHOOK_EVENT_TYPES.TRANSACTION_COMPLETED:
            await handleTransactionCompleted(c, event.data);
            break;
          
          default:
            logger.info('Unhandled event type', { 
              requestId, 
              eventType: event.event_type 
            });
        }
      }
      
    } catch (error) {
      logger.error('Webhook event processing failed', {
        requestId,
        eventId: event.event_id,
        eventType: event.event_type,
        error: error.message
      });
      
      throw error; // Re-throw to trigger proper error response
    }

  return c.json({ received: true, requestId });
}

/**
 * Handle subscription created events
 */
async function handleSubscriptionCreated(c, subscription) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    await syncEntitlements(c, subscription, 'created');
    logger.info('Subscription created processed', { 
      requestId, 
      subscriptionId: subscription.id 
    });
  } catch (error) {
    logger.error('Failed to process subscription creation', {
      requestId,
      subscriptionId: subscription.id,
      error: error.message
    });
    throw error;
  }
}

/**
 * Handle subscription updated events
 */
async function handleSubscriptionUpdated(c, subscription) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    await syncEntitlements(c, subscription, 'updated');
    logger.info('Subscription updated processed', { 
      requestId, 
      subscriptionId: subscription.id 
    });
  } catch (error) {
    logger.error('Failed to process subscription update', {
      requestId,
      subscriptionId: subscription.id,
      error: error.message
    });
    throw error;
  }
}

/**
 * Handle subscription canceled events
 */
async function handleSubscriptionCanceled(c, subscription) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    await syncEntitlements(c, subscription, WEBHOOK_EVENT_TYPES.SUBSCRIPTION_CANCELED);
    logger.info('Subscription canceled processed', { 
      requestId, 
      subscriptionId: subscription.id 
    });
  } catch (error) {
    logger.error('Failed to process subscription cancellation', {
      requestId,
      subscriptionId: subscription.id,
      error: error.message
    });
    throw error;
  }
}

/**
 * Handle transaction completed events
 */
async function handleTransactionCompleted(c, transaction) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  logger.info('Transaction completed', { 
    requestId, 
    transactionId: transaction.id 
  });
  
  // Could implement one-time purchase handling here
}

/**
 * Sync subscription data to entitlements
 */
async function syncEntitlements(c, subscription, eventType) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  // 1. Extract userId from custom_data
  const userId = subscription.custom_data?.clerkUserId;
  
  if (!userId) {
    logger.warn('No clerkUserId in custom_data, skipping sync', {
      requestId,
      subscriptionId: subscription.id
    });
    return;
  }
  
  // 2. Map subscription to plan and status
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
      plan = mapPaddlePriceToPlan(priceId, c.env.BUSINESS_PRICE_ID);
    }
  }
  
  // 3. Prepare metadata
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
  
  // Track scheduled changes (cancellations, pauses)
  if (subscription.scheduled_change) {
    meta.scheduledChange = {
      action: subscription.scheduled_change.action,
      effectiveAt: subscription.scheduled_change.effective_at,
      resumeAt: subscription.scheduled_change.resume_at
    };
  }
  
  // Track actual cancellation timestamp
  if (subscription.canceled_at) {
    meta.canceledAt = subscription.canceled_at;
  }
  
  // 4. Check for subscription conflicts before updating entitlements
  const users = new UsersService(c.env.ENTITLEMENTS, logger);
  const existingEntitlements = await users.get(userId);
  
  // Detect multiple active subscriptions conflict
  const hasActiveExisting = existingEntitlements && 
    [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING].includes(existingEntitlements.status) &&
    existingEntitlements.meta?.subscriptionId !== subscription.id;
    
  const hasActiveNew = [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING].includes(status);
  
  if (hasActiveExisting && hasActiveNew) {
    logger.warn('Multiple active subscriptions detected for user', {
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
      logger.info('Keeping existing higher-value subscription, skipping update', {
        requestId,
        userId,
        keptPlan: existingEntitlements.plan,
        skippedPlan: plan
      });
      
      // TODO: Consider auto-canceling the lower-value subscription via Paddle API
      // This would require implementing Paddle API client
      
      return existingEntitlements; // Don't update, keep existing
    } else {
      logger.info('New subscription has higher value, updating entitlements', {
        requestId,
        userId,
        previousPlan: existingEntitlements.plan,
        newPlan: plan
      });
    }
  }
  
  // 5. Update entitlements in KV
  const entitlements = await users.set(userId, {
    plan,
    status,
    provider: SUBSCRIPTION_PROVIDERS.PADDLE,
    meta
  });
  
  logger.info('Entitlements synced from webhook', {
    requestId,
    userId,
    plan: entitlements.plan,
    status: entitlements.status,
    subscriptionId: subscription.id
  });
}

/**
 * Generate customer portal URL for subscription management
 * POST /api/paddle/portal
 */
export async function handleCustomerPortal(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const { customerId } = await c.req.json();
    
    if (!customerId) {
      return c.json({ 
        error: 'Customer ID is required',
        requestId 
      }, 400);
    }

    const portalUrl = await generateCustomerPortalUrl(c, customerId);
    
    logger.info('Customer portal URL generated', {
      requestId,
      customerId,
      hasUrl: !!portalUrl
    });

    return c.json({ 
      portalUrl,
      requestId 
    });
    
  } catch (error) {
    logger.error('Failed to generate customer portal URL', {
      requestId,
      error: error.message,
      stack: error.stack
    });
    
    return c.json({ 
      error: 'Failed to generate portal URL',
      requestId 
    }, 500);
  }
}

/**
 * Cancel subscription directly via Paddle API
 * POST /api/paddle/cancel
 */
export async function handleSubscriptionCancel(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const { subscriptionId, cancellationReason } = await c.req.json();
    
    if (!subscriptionId) {
      return c.json({ 
        error: 'Subscription ID is required',
        requestId 
      }, 400);
    }

    const cancelResult = await cancelSubscriptionViaPaddle(c, subscriptionId, cancellationReason);
    
    logger.info('Subscription canceled directly', {
      requestId,
      subscriptionId,
      reason: cancellationReason,
      success: !!cancelResult
    });

    return c.json({ 
      success: true,
      subscription: cancelResult,
      requestId 
    });
    
  } catch (error) {
    logger.error('Failed to cancel subscription', {
      requestId,
      error: error.message,
      stack: error.stack
    });
    
    return c.json({ 
      error: 'Failed to cancel subscription',
      details: error.message,
      requestId 
    }, 500);
  }
}

/**
 * Generate customer portal URL using Paddle API
 */
async function generateCustomerPortalUrl(c, customerId) {
  const paddleApiKey = c.env.PADDLE_API_KEY;
  const paddleEnvironment = c.env.PADDLE_ENVIRONMENT || 'sandbox';
  
  if (!paddleApiKey) {
    throw new Error('PADDLE_API_KEY environment variable is required');
  }

  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  logger.info('Generating customer portal URL', {
    requestId,
    customerId,
    environment: paddleEnvironment,
    hasApiKey: !!paddleApiKey,
    apiKeyPrefix: paddleApiKey ? paddleApiKey.substring(0, 10) + '...' : 'none'
  });

  const baseUrl = paddleEnvironment === 'production' 
    ? 'https://api.paddle.com' 
    : 'https://sandbox-api.paddle.com';

  const response = await fetch(`${baseUrl}/customers/${customerId}/portal-sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${paddleApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Paddle API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.data?.urls?.general?.overview;
}

/**
 * Cancel subscription using Paddle API
 */
async function cancelSubscriptionViaPaddle(c, subscriptionId, reason) {
  const paddleApiKey = c.env.PADDLE_API_KEY;
  const paddleEnvironment = c.env.PADDLE_ENVIRONMENT || 'sandbox';
  
  // TODO(human): Add enhanced environment variable validation and debugging info
  if (!paddleApiKey) {
    throw new Error('PADDLE_API_KEY environment variable is required');
  }

  const baseUrl = paddleEnvironment === 'production' 
    ? 'https://api.paddle.com' 
    : 'https://sandbox-api.paddle.com';

  const body = {
    effective_from: 'next_billing_period'
  };

  if (reason) {
    body.cancellation_reason = reason;
  }

  const response = await fetch(`${baseUrl}/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${paddleApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Paddle API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.data;
}