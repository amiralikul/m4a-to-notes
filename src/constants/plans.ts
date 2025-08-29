/**
 * Plan and Subscription Constants
 * Centralized configuration for subscription plans, statuses, and pricing
 */

export const SUBSCRIPTION_PLANS = {
  FREE: 'free',
  PRO: 'pro',
  BUSINESS: 'business'
};

export const SUBSCRIPTION_STATUS = {
  NONE: 'none',
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled'
};

export const PADDLE_STATUS = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled'
};

export const SUBSCRIPTION_PROVIDERS = {
  PADDLE: 'paddle'
};

export const PADDLE_PRICE_IDS = {
  PRO_MONTHLY: 'pri_01k399jhfp27dnef4eah1z28y2',
  // BUSINESS_MONTHLY will be loaded from env.BUSINESS_PRICE_ID
};

export const PLAN_HIERARCHY = {
  [SUBSCRIPTION_PLANS.FREE]: 0,
  [SUBSCRIPTION_PLANS.PRO]: 1,
  [SUBSCRIPTION_PLANS.BUSINESS]: 2
};

export const WEBHOOK_EVENT_TYPES = {
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_UPDATED: 'subscription.updated',
  SUBSCRIPTION_CANCELED: 'subscription.canceled',
  TRANSACTION_COMPLETED: 'transaction.completed'
};

export const QUEUE_MESSAGE_TYPES = {
  TRANSCRIPTION: 'transcription'
};

export function mapPaddleStatus(paddleStatus: string): string {
  const status = paddleStatus?.toLowerCase();
  
  switch (status) {
    case PADDLE_STATUS.ACTIVE:
      return SUBSCRIPTION_STATUS.ACTIVE;
    case PADDLE_STATUS.TRIALING:
      return SUBSCRIPTION_STATUS.TRIALING;
    case PADDLE_STATUS.PAST_DUE:
      return SUBSCRIPTION_STATUS.PAST_DUE;
    case PADDLE_STATUS.CANCELED:
      return SUBSCRIPTION_STATUS.CANCELED;
    default:
      return SUBSCRIPTION_STATUS.NONE;
  }
}

/**
 * Map Paddle price ID to plan
 * @param {string} priceId - Price ID from Paddle
 * @param {string} businessPriceId - Business price ID from environment
 * @returns {string} Internal plan name
 */
export function mapPaddlePriceToPlan(priceId: string, businessPriceId: string): string {
  if (priceId === PADDLE_PRICE_IDS.PRO_MONTHLY) {
    return SUBSCRIPTION_PLANS.PRO;
  } else if (priceId === businessPriceId) {
    return SUBSCRIPTION_PLANS.BUSINESS;
  } else if (priceId) {
    // Default for any other paid subscription
    return SUBSCRIPTION_PLANS.PRO;
  }
  
  return SUBSCRIPTION_PLANS.FREE;
}


export function getPlanHierarchyValue(plan: string): number {
  return PLAN_HIERARCHY[plan] || 0;
}

/**
 * Check if a subscription is scheduled for cancellation
 * @param {Object} entitlements - User entitlements object
 * @returns {Object|null} Cancellation info or null if not scheduled
 */
export function getScheduledCancellation(entitlements) {
  const meta = entitlements?.meta;
  
  if (!meta?.scheduledChange) {
    return null;
  }
  
  const { action, effectiveAt } = meta.scheduledChange;
  
  if (action === 'cancel' && effectiveAt) {
    const effectiveDate = new Date(effectiveAt);
    const now = new Date();
    
    // Only return if cancellation is in the future
    if (effectiveDate > now) {
      return {
        isScheduled: true,
        effectiveAt: effectiveAt,
        effectiveDate: effectiveDate,
        daysUntilCancellation: Math.ceil((effectiveDate - now) / (1000 * 60 * 60 * 24))
      };
    }
  }
  
  return null;
}

/**
 * Format scheduled cancellation message for UI display
 * @param {Object} entitlements - User entitlements object
 * @returns {string|null} Formatted message or null if not scheduled
 */
export function formatScheduledCancellationMessage(entitlements) {
  const cancellation = getScheduledCancellation(entitlements);
  
  if (!cancellation) {
    return null;
  }
  
  const date = cancellation.effectiveDate;
  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  };
  
  const formattedDate = date.toLocaleDateString('en-US', options);
  
  return `Scheduled cancellation\nThis subscription is scheduled to be canceled on ${formattedDate}`;
}