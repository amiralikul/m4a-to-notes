/**
 * Paddle Reconciliation Service
 * Handles periodic reconciliation between Paddle subscriptions and local entitlements
 */

import { UsersService } from './users.js';
import { 
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDERS,
  mapPaddleStatus,
  mapPaddlePriceToPlan
} from '../constants/plans.js';

export class PaddleReconciliationService {
  constructor(env, logger) {
    this.env = env;
    this.logger = logger;
    this.users = new UsersService(env.ENTITLEMENTS, logger);
    this.paddleApiKey = env.PADDLE_API_KEY;
    this.paddleEnvironment = env.PADDLE_ENVIRONMENT || 'sandbox';
  }

  /**
   * Run reconciliation job to sync mismatched subscriptions
   * @param {Object} options - Reconciliation options
   * @param {number} options.hours - Hours to look back for updates (default: 48)
   * @param {boolean} options.dryRun - If true, only log differences without updating
   */
  async runReconciliation(options = {}) {
    const { hours = 48, dryRun = false } = options;
    
    this.logger.info('Starting Paddle reconciliation job', {
      hoursBack: hours,
      dryRun,
      environment: this.paddleEnvironment
    });

    if (!this.paddleApiKey) {
      throw new Error('PADDLE_API_KEY environment variable is required for reconciliation');
    }

    try {
      // Get recent subscriptions from Paddle API
      const paddleSubscriptions = await this.fetchRecentSubscriptions(hours);
      
      this.logger.info('Fetched subscriptions from Paddle', {
        count: paddleSubscriptions.length,
        hoursBack: hours
      });

      let mismatches = 0;
      let fixed = 0;
      const errors = [];

      // Check each Paddle subscription against local entitlements
      for (const subscription of paddleSubscriptions) {
        try {
          const result = await this.reconcileSubscription(subscription, dryRun);
          if (result.mismatch) {
            mismatches++;
            if (result.fixed) {
              fixed++;
            }
          }
        } catch (error) {
          this.logger.error('Failed to reconcile subscription', {
            subscriptionId: subscription.id,
            error: error.message
          });
          errors.push({
            subscriptionId: subscription.id,
            error: error.message
          });
        }
      }

      const summary = {
        subscriptionsChecked: paddleSubscriptions.length,
        mismatchesFound: mismatches,
        mismatchesFixed: fixed,
        errors: errors.length,
        dryRun
      };

      this.logger.info('Reconciliation job completed', summary);
      
      return summary;

    } catch (error) {
      this.logger.error('Reconciliation job failed', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Fetch recent subscriptions from Paddle API
   * @param {number} hours - Hours to look back
   * @returns {Promise<Array>} Array of subscription objects
   */
  async fetchRecentSubscriptions(hours) {
    const baseUrl = this.paddleEnvironment === 'production' 
      ? 'https://api.paddle.com' 
      : 'https://sandbox-api.paddle.com';

    // Calculate the updated_at filter (ISO format)
    const updatedAfter = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    
    const url = `${baseUrl}/subscriptions?updated_after=${updatedAfter}&per_page=200`;
    
    this.logger.info('Fetching subscriptions from Paddle API', {
      url,
      updatedAfter,
      environment: this.paddleEnvironment
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.paddleApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Paddle API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.data || [];
  }

  /**
   * Reconcile a single subscription against local entitlements
   * @param {Object} subscription - Paddle subscription object
   * @param {boolean} dryRun - If true, only check without updating
   * @returns {Promise<Object>} Reconciliation result
   */
  async reconcileSubscription(subscription, dryRun) {
    // Extract userId from custom_data
    const userId = subscription.custom_data?.clerkUserId;
    
    if (!userId) {
      this.logger.debug('Subscription has no clerkUserId, skipping', {
        subscriptionId: subscription.id
      });
      return { mismatch: false, reason: 'no_user_id' };
    }

    // Get current local entitlements
    const localEntitlements = await this.users.get(userId);
    
    // Map Paddle subscription to expected entitlements
    const expectedEntitlements = this.mapPaddleToEntitlements(subscription);
    
    // Check for mismatches
    const mismatch = this.detectMismatch(localEntitlements, expectedEntitlements);
    
    if (!mismatch.found) {
      this.logger.debug('Subscription matches local entitlements', {
        subscriptionId: subscription.id,
        userId,
        plan: expectedEntitlements.plan,
        status: expectedEntitlements.status
      });
      return { mismatch: false };
    }

    this.logger.warn('Subscription mismatch detected', {
      subscriptionId: subscription.id,
      userId,
      mismatch: mismatch.details,
      expected: expectedEntitlements,
      current: localEntitlements
    });

    if (dryRun) {
      return { 
        mismatch: true, 
        fixed: false, 
        reason: 'dry_run',
        details: mismatch.details 
      };
    }

    // Update local entitlements to match Paddle
    try {
      await this.users.set(userId, expectedEntitlements);
      
      this.logger.info('Fixed subscription mismatch', {
        subscriptionId: subscription.id,
        userId,
        updated: expectedEntitlements
      });
      
      return { 
        mismatch: true, 
        fixed: true, 
        details: mismatch.details 
      };
    } catch (error) {
      this.logger.error('Failed to fix subscription mismatch', {
        subscriptionId: subscription.id,
        userId,
        error: error.message
      });
      
      return { 
        mismatch: true, 
        fixed: false, 
        error: error.message,
        details: mismatch.details 
      };
    }
  }

  /**
   * Map Paddle subscription to expected local entitlements
   * @param {Object} subscription - Paddle subscription object
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
      plan = mapPaddlePriceToPlan(priceId, this.env.BUSINESS_PRICE_ID);
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
      meta
    };
  }

  /**
   * Detect mismatches between local and expected entitlements
   * @param {Object|null} local - Current local entitlements
   * @param {Object} expected - Expected entitlements from Paddle
   * @returns {Object} Mismatch detection result
   */
  detectMismatch(local, expected) {
    if (!local) {
      return {
        found: true,
        details: {
          type: 'missing_local_entitlements',
          expected,
          current: null
        }
      };
    }

    const differences = [];
    
    if (local.plan !== expected.plan) {
      differences.push({
        field: 'plan',
        current: local.plan,
        expected: expected.plan
      });
    }
    
    if (local.status !== expected.status) {
      differences.push({
        field: 'status',
        current: local.status,
        expected: expected.status
      });
    }
    
    if (local.meta?.subscriptionId !== expected.meta?.subscriptionId) {
      differences.push({
        field: 'subscriptionId',
        current: local.meta?.subscriptionId,
        expected: expected.meta?.subscriptionId
      });
    }

    return {
      found: differences.length > 0,
      details: differences
    };
  }
}