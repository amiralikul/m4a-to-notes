/**
 * Centralized Paddle synchronization service
 * Inspired by T3's syncStripeDataToKV() pattern
 * Always fetches canonical state from Paddle API instead of trusting webhook data
 */

import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDERS,
  PADDLE_PRICE_IDS,
  PLAN_HIERARCHY,
  mapPaddleStatus,
  mapPaddlePriceToPlan,
  getPlanHierarchyValue
} from '../constants/plans.js';

export class PaddleSyncService {
  constructor(env, logger) {
    this.paddleApiKey = env.PADDLE_API_KEY;
    this.paddleEnvironment = env.PADDLE_ENVIRONMENT || 'sandbox';
    this.businessPriceId = env.BUSINESS_PRICE_ID;
    this.logger = logger;
    this.kv = env.ENTITLEMENTS;
    
    if (!this.paddleApiKey) {
      throw new Error('PADDLE_API_KEY environment variable is required');
    }
    
    if (!this.kv) {
      throw new Error('ENTITLEMENTS binding is required');
    }
  }
  
  /**
   * Fetch canonical subscription state from Paddle API
   * @param {string} subscriptionId - Paddle subscription ID
   * @returns {Promise<Object>} Canonical subscription object
   */
  async fetchCanonicalSubscription(subscriptionId) {
    const baseUrl = this.paddleEnvironment === 'production' 
      ? 'https://api.paddle.com' 
      : 'https://sandbox-api.paddle.com';
      
    this.logger.info('Fetching canonical subscription from Paddle API', {
      subscriptionId,
      environment: this.paddleEnvironment
    });
      
    const response = await fetch(`${baseUrl}/subscriptions/${subscriptionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.paddleApiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error('Failed to fetch canonical subscription', {
        subscriptionId,
        status: response.status,
        error: errorText
      });
      throw new Error(`Failed to fetch subscription ${subscriptionId}: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.data; // Return canonical subscription object
  }
  
  /**
   * Main sync function using canonical state
   * @param {string} subscriptionId - Extract from webhook event
   * @param {string} eventType - Webhook event type for context
   * @param {Object} context - Additional context for sync operation
   */
  async syncPaddleDataToKV(subscriptionId, eventType, context = {}) {
    try {
      // Always fetch canonical state, never trust webhook data
      const canonicalSubscription = await this.fetchCanonicalSubscription(subscriptionId);
      
      this.logger.info('Fetched canonical subscription state', {
        subscriptionId,
        eventType,
        status: canonicalSubscription.status,
        customerId: canonicalSubscription.customer_id
      });
      
      // Use canonical data for all sync operations
      await this.updateEntitlements(canonicalSubscription);
      
    } catch (error) {
      this.logger.error('Canonical sync failed', {
        subscriptionId,
        eventType,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Update entitlements in KV store using canonical subscription data
   * @param {Object} canonicalSubscription - Fresh subscription data from Paddle API
   */
  async updateEntitlements(canonicalSubscription) {
    const customerId = canonicalSubscription.customer_id;
    const subscriptionId = canonicalSubscription.id;
    
    // Get current entitlements
    const currentKey = `entitlements:${customerId}`;
    const currentEntitlements = await this.kv.get(currentKey, 'json');
    
    // Map canonical subscription to expected entitlements
    const expectedEntitlements = this.mapPaddleToEntitlements(canonicalSubscription);
    
    // Detect and resolve conflicts
    const conflictResult = this.detectConflicts(currentEntitlements, expectedEntitlements);
    
    if (conflictResult.hasConflict) {
      this.logger.warn('Resolving subscription conflict', {
        customerId,
        subscriptionId,
        conflict: conflictResult.details
      });
      
      // Use conflict resolution logic
      const resolvedEntitlements = this.resolveConflict(
        currentEntitlements, 
        expectedEntitlements, 
        conflictResult
      );
      
      await this.kv.put(currentKey, JSON.stringify(resolvedEntitlements));
      
      this.logger.info('Conflict resolved and entitlements updated', {
        customerId,
        subscriptionId,
        plan: resolvedEntitlements.plan,
        status: resolvedEntitlements.status
      });
    } else {
      // No conflict, direct update
      await this.kv.put(currentKey, JSON.stringify(expectedEntitlements));
      
      this.logger.info('Entitlements updated from canonical state', {
        customerId,
        subscriptionId,
        plan: expectedEntitlements.plan,
        status: expectedEntitlements.status
      });
    }
  }
  
  /**
   * Map Paddle subscription to expected local entitlements
   * @param {Object} subscription - Canonical Paddle subscription object
   * @returns {Object} Expected entitlements object
   */
  mapPaddleToEntitlements(subscription) {
    let plan = SUBSCRIPTION_PLANS.FREE;
    let status = SUBSCRIPTION_STATUS.NONE;
    
    // Map subscription status using utility function
    status = mapPaddleStatus(subscription.status);

    // Map subscription items to plan
    if (subscription.items && subscription.items.length > 0) {
      const priceId = subscription.items[0].price?.id;
      plan = mapPaddlePriceToPlan(priceId, this.businessPriceId);
    }
    
    // If canceled, revert to free plan
    if (status === SUBSCRIPTION_STATUS.CANCELED) {
      plan = SUBSCRIPTION_PLANS.FREE;
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

    return {
      plan,
      status,
      provider: SUBSCRIPTION_PROVIDERS.PADDLE,
      meta,
      lastUpdated: new Date().toISOString(),
      source: 'canonical_api' // Mark as canonical for debugging
    };
  }
  
  /**
   * Detect conflicts between current and expected entitlements
   * @param {Object|null} current - Current local entitlements
   * @param {Object} expected - Expected entitlements from canonical state
   * @returns {Object} Conflict detection result
   */
  detectConflicts(current, expected) {
    if (!current) {
      return {
        hasConflict: false,
        details: {
          type: 'no_existing_entitlements',
          expected,
          current: null
        }
      };
    }

    const differences = [];
    
    if (current.plan !== expected.plan) {
      differences.push({
        field: 'plan',
        current: current.plan,
        expected: expected.plan
      });
    }
    
    if (current.status !== expected.status) {
      differences.push({
        field: 'status',
        current: current.status,
        expected: expected.status
      });
    }
    
    // Check for subscription ID conflicts (multiple subscriptions)
    if (current.meta?.subscriptionId !== expected.meta?.subscriptionId) {
      differences.push({
        field: 'subscriptionId',
        current: current.meta?.subscriptionId,
        expected: expected.meta?.subscriptionId
      });
    }

    return {
      hasConflict: differences.length > 0,
      details: {
        type: differences.length > 0 ? 'field_mismatch' : 'no_differences',
        differences,
        expected,
        current
      }
    };
  }
  
  /**
   * Resolve conflicts using plan hierarchy and recency
   * @param {Object} current - Current entitlements
   * @param {Object} expected - Expected entitlements from canonical state
   * @param {Object} conflictResult - Result from detectConflicts
   * @returns {Object} Resolved entitlements
   */
  resolveConflict(current, expected, conflictResult) {
    const { differences } = conflictResult.details;
    
    // Plan conflicts: use highest plan in hierarchy
    const planDiff = differences.find(d => d.field === 'plan');
    if (planDiff) {
      const currentHierarchy = getPlanHierarchyValue(current.plan);
      const expectedHierarchy = getPlanHierarchyValue(expected.plan);
      
      if (expectedHierarchy >= currentHierarchy) {
        // Canonical state has equal or higher plan, use it
        return expected;
      } else {
        // Current has higher plan, keep it but update metadata
        return {
          ...current,
          meta: {
            ...current.meta,
            ...expected.meta, // Update metadata with canonical info
          },
          lastUpdated: new Date().toISOString(),
          source: 'conflict_resolved'
        };
      }
    }
    
    // For other conflicts, canonical state wins
    return expected;
  }
}