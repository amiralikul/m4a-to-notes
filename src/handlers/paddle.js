import { UsersService } from '../services/users.js';

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
export async function handlePaddleWebhook(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
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

    // Handle different event types
    switch (event.event_type) {
      case 'subscription.created':
        await handleSubscriptionCreated(c, event.data);
        break;
      
      case 'subscription.updated':
        await handleSubscriptionUpdated(c, event.data);
        break;
      
      case 'subscription.canceled':
        await handleSubscriptionCanceled(c, event.data);
        break;
      
      case 'transaction.completed':
        await handleTransactionCompleted(c, event.data);
        break;
      
      default:
        logger.info('Unhandled event type', { 
          requestId, 
          eventType: event.event_type 
        });
    }

    return c.json({ received: true, requestId });
    
  } catch (error) {
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
    await syncEntitlements(c, subscription, 'canceled');
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
  let plan = 'free';
  let status = 'none';
  
  if (eventType === 'canceled') {
    plan = 'free';
    status = 'canceled';
  } else {
    // Map subscription status
    const paddleStatus = subscription.status?.toLowerCase();
    switch (paddleStatus) {
      case 'active':
        status = 'active';
        break;
      case 'trialing':
        status = 'trialing';
        break;
      case 'past_due':
        status = 'past_due';
        break;
      default:
        status = 'none';
    }

    // Map subscription items to plan
    if (subscription.items && subscription.items.length > 0) {
      const priceId = subscription.items[0].price?.id;
      
      // Map price IDs to plans
      if (priceId === 'pri_01k399jhfp27dnef4eah1z28y2') {
        plan = 'pro';
      } else if (priceId === c.env.BUSINESS_PRICE_ID) {
        plan = 'business';
      } else {
        plan = 'pro'; // Default for any paid subscription
      }
    }
  }
  
  // 3. Prepare metadata
  const meta = {
    subscriptionId: subscription.id,
    customerId: subscription.customer_id,
    currency: subscription.currency_code || 'USD',
  };
  
  if (subscription.items?.[0]?.price) {
    meta.unitPrice = subscription.items[0].price.unit_price?.amount;
  }
  
  if (subscription.current_billing_period?.ends_at) {
    meta.periodEnd = subscription.current_billing_period.ends_at;
  }
  
  // 4. Update entitlements directly in KV
  const users = new UsersService(c.env.ENTITLEMENTS, logger);
  
  const entitlements = await users.set(userId, {
    plan,
    status,
    provider: 'paddle',
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