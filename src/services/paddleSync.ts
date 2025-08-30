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
import { UsersService } from './users.js';
import { Database } from '../db';

export class PaddleSyncService {
  private paddleApiKey: string;
  private paddleEnvironment: string;
  private businessPriceId: string;
  private logger: any;
  private users: UsersService;

  constructor(database: Database, env: Env, logger: any) {
    this.paddleApiKey = env.PADDLE_API_KEY;
    this.paddleEnvironment = env.PADDLE_ENVIRONMENT || 'sandbox';
    // BUSINESS_PRICE_ID may not exist on Env typings
    this.businessPriceId = (env as any).BUSINESS_PRICE_ID;
    this.logger = logger;
    this.users = new UsersService(database, logger);
    
    if (!this.paddleApiKey) {
      throw new Error('PADDLE_API_KEY environment variable is required');
    }
    
    if (!this.users) {
      throw new Error('UsersService is required');
    }
  }
  
  /**
   * Fetch canonical subscription state from Paddle API
   * @param {string} subscriptionId - Paddle subscription ID
   * @returns {Promise<Object>} Canonical subscription object
   */
  async fetchCanonicalSubscription(subscriptionId: string): Promise<CanonicalSubscription> {
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
    
    const data = await response.json() as any;
    return data.data as CanonicalSubscription; // Return canonical subscription object
  }
  
  /**
   * Main sync function using canonical state
   * @param {string} subscriptionId - Extract from webhook event
   * @param {string} eventType - Webhook event type for context
   * @param {Object} context - Additional context for sync operation
   */
  async syncPaddleDataToKV(subscriptionId: string, eventType: string, context: Record<string, unknown> = {}) {
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
      
    } catch (error: unknown) {
      this.logger.error('Canonical sync failed', {
        subscriptionId,
        eventType,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  
  /**
   * Update entitlements in database using canonical subscription data
   * @param {Object} canonicalSubscription - Fresh subscription data from Paddle API
   */
  async updateEntitlements(canonicalSubscription: CanonicalSubscription): Promise<void> {
    const customerId = canonicalSubscription.customer_id;
    const subscriptionId = canonicalSubscription.id;

    // Read current entitlements from SQLite (by userId)
    const currentEntitlements = await this.users.get(customerId);

    // Map canonical subscription to normalized structure
    const expectedEntitlements = this.mapPaddleToEntitlements(canonicalSubscription);

    // Persist to SQLite using UsersService (SQLite schema fields only)
    const saved = await this.users.set(customerId, {
      plan: expectedEntitlements.plan,
      status: expectedEntitlements.status,
      // If available, store billing period end as expiresAt for convenience
      expiresAt: expectedEntitlements?.meta?.periodEnd,
      // Preserve existing feature/limit shapes if present
      features: currentEntitlements?.features || [],
      limits: currentEntitlements?.limits || {}
    });

    this.logger.info('Entitlements updated from canonical state', {
      customerId,
      subscriptionId,
      plan: saved.plan,
      status: saved.status
    });
  }
  
  /**
   * Map Paddle subscription to expected local entitlements
   * @param {Object} subscription - Canonical Paddle subscription object
   * @returns {Object} Expected entitlements object
   */
  mapPaddleToEntitlements(subscription: CanonicalSubscription): EntitlementsMapping {
    let plan = SUBSCRIPTION_PLANS.FREE;
    let status = SUBSCRIPTION_STATUS.NONE;
    
    // Map subscription status using utility function
    status = mapPaddleStatus(subscription.status);

    // Map subscription items to plan
    if (subscription.items && subscription.items.length > 0) {
      const priceId = subscription.items[0].price?.id || '';
      plan = mapPaddlePriceToPlan(priceId, this.businessPriceId || '');
    }
    
    // If canceled, revert to free plan
    if (status === SUBSCRIPTION_STATUS.CANCELED) {
      plan = SUBSCRIPTION_PLANS.FREE;
    }

    // Prepare metadata
    const meta: EntitlementsMapping['meta'] = {
      subscriptionId: subscription.id,
      customerId: subscription.customer_id,
      currency: subscription.currency_code || 'USD',
      name: subscription.items?.[0]?.name || 'Unknown',
      priceId: subscription.items?.[0]?.price?.id || 'Unknown',
    };
    
    if (subscription.items?.[0]?.price) {
      meta.unitPrice = subscription.items[0].price?.unit_price?.amount;
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
  detectConflicts(current: EntitlementsMapping | null, expected: EntitlementsMapping) {
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

    const differences: Array<{ field: string; current: unknown; expected: unknown }> = [];
    
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
  resolveConflict(current: EntitlementsMapping, expected: EntitlementsMapping, conflictResult: { details: { differences: Array<{ field: string }> } }): EntitlementsMapping {
    const { differences } = conflictResult.details;
    
    // Plan conflicts: use highest plan in hierarchy
    const planDiff = differences.find((d) => d.field === 'plan');
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

// Types: narrow subset of Paddle entities we use
interface CanonicalSubscription {
  id: string;
  customer_id: string;
  status: string;
  items?: Array<{
    name?: string;
    price?: {
      id?: string;
      unit_price?: { amount?: number };
    };
  }>;
  currency_code?: string;
  current_billing_period?: { ends_at?: string };
  scheduled_change?: { action: string; effective_at?: string; resume_at?: string };
  canceled_at?: string;
}

interface EntitlementsMapping {
  plan: string;
  status: string;
  provider: string;
  meta: {
    subscriptionId: string;
    customerId: string;
    currency: string;
    name: string;
    priceId: string;
    unitPrice?: number;
    periodEnd?: string;
    scheduledChange?: { action: string; effectiveAt?: string; resumeAt?: string };
    canceledAt?: string;
  };
  lastUpdated: string;
  source: string;
}