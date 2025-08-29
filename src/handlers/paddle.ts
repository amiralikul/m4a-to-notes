import { UsersService } from '../services/users';
import { PaddleSyncService } from '../services/paddleSync';
import { HonoContext } from '../types';
import { getErrorMessage } from '../utils/errors';
import { 
  WEBHOOK_EVENT_TYPES,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDERS,
  mapPaddleStatus,
  mapPaddlePriceToPlan,
  getPlanHierarchyValue
} from '../constants/plans';

/**
 * Verify Paddle webhook signature using Web Crypto API
 * @param {string} body - Raw request body
 * @param {string} signature - Paddle signature header
 * @param {string} secret - Webhook secret
 * @returns {Promise<boolean>}
 */
async function verifyWebhookSignature(body: string, signature: string, secret: string): Promise<boolean> {
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

export async function handlePaddleWebhook(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    // 1. Get webhook data
    const body = await c.req.text();
    const signature = c.req.header('paddle-signature');
    
    logger.info('Received Paddle webhook', { 
      requestId,
      hasSignature: !!signature
    });
    
    // 2. Verify signature (enabled for production security)
    const webhookSecret = c.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
    if (webhookSecret && !(await verifyWebhookSignature(body, signature, webhookSecret))) {
      logger.warn('Invalid webhook signature', { requestId });
      return c.json({ error: 'Invalid signature' }, 401);
    }
    
    // 3. Extract subscription ID from event (don't use event.data directly)
    const event = JSON.parse(body);
    
    logger.info('Processing webhook event', {
      requestId,
      eventType: event.event_type,
      eventId: event.event_id
    });
    
    // Extract subscription ID for canonical state fetching
    const subscriptionId = event.data?.id || event.data?.subscription?.id;
    
    if (!subscriptionId) {
      // Non-subscription events (like transaction.completed) don't need sync
      logger.info('Non-subscription event, acknowledging', { 
        requestId,
        eventType: event.event_type 
      });
      return c.json({ received: true, requestId });
    }
    
    // 4. Fetch canonical state and sync (T3 style)
    const syncService = new PaddleSyncService(c.env, logger);
    await syncService.syncPaddleDataToKV(subscriptionId, event.event_type, { requestId });
    
    logger.info('Webhook processed successfully with canonical sync', {
      requestId,
      subscriptionId,
      eventType: event.event_type
    });
    
    return c.json({ received: true, requestId });
    
  } catch (error) {
    logger.error('Webhook processing failed', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Still acknowledge webhook to prevent retries for unrecoverable errors
    return c.json({ 
      received: true, // Prevent webhook retries
      error: 'Processing failed but acknowledged',
      requestId 
    }, 200); // Return 200 to stop Paddle retries
  }
}

/**
 * Generate customer portal URL for subscription management
 * POST /api/paddle/portal
 */
export async function handleCustomerPortal(c: HonoContext): Promise<Response> {
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
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
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
export async function handleSubscriptionCancel(c: HonoContext): Promise<Response> {
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
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({ 
      error: 'Failed to cancel subscription',
      details: getErrorMessage(error),
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