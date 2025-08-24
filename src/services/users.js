/**
 * Users Service
 * Handles user entitlements and subscription management using KV storage
 */

export class UsersService {
  constructor(entitlementsKV, logger) {
    this.entitlementsKV = entitlementsKV;
    this.logger = logger;
  }

  /**
   * Get user entitlements from KV storage
   * @param {string} userId - Clerk user ID
   * @returns {Promise<Object|null>} User entitlements or null if not found
   */
  async get(userId) {
    try {
      if (!userId) {
        throw new Error('User ID is required');
      }

      const entitlementsData = await this.entitlementsKV.get(userId);

      
      if (!entitlementsData) {
        this.logger.info('No entitlements found for user', { userId });
        return null;
      }

      const entitlements = JSON.parse(entitlementsData);
      
      this.logger.info('Retrieved user entitlements', { 
        userId, 
        plan: entitlements.plan,
        status: entitlements.status 
      });
      
      return entitlements;
    } catch (error) {
      this.logger.error('Failed to retrieve user entitlements', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Set user entitlements in KV storage
   * @param {string} userId - Clerk user ID
   * @param {Object} entitlementsData - Entitlements data to store
   * @param {string} entitlementsData.plan - User plan: 'free' | 'pro' | 'business'
   * @param {string} entitlementsData.status - Subscription status: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled'
   * @param {string} entitlementsData.provider - Payment provider: 'paddle'
   * @param {Object} entitlementsData.meta - Additional metadata
   * @returns {Promise<Object>} Updated entitlements
   */
  async set(userId, entitlementsData) {
    try {
      if (!userId) {
        throw new Error('User ID is required');
      }

      // Get existing entitlements to merge with new data
      const existing = await this.get(userId);
      
      // Prepare the entitlements object
      const entitlements = {
        userId,
        plan: entitlementsData.plan || 'free',
        status: entitlementsData.status || 'none',
        provider: entitlementsData.provider || 'paddle',
        meta: {
          ...existing?.meta,
          ...entitlementsData.meta
        },
        updatedAt: new Date().toISOString()
      };

      // Validate plan and status values
      this._validateEntitlements(entitlements);

      // Store in KV
      await this.entitlementsKV.put(userId, JSON.stringify(entitlements));

      this.logger.info('Updated user entitlements', {
        userId,
        plan: entitlements.plan,
        status: entitlements.status,
        provider: entitlements.provider
      });

      return entitlements;
    } catch (error) {
      this.logger.error('Failed to update user entitlements', {
        userId,
        entitlementsData,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get user entitlements with default values for new users
   * @param {string} userId - Clerk user ID
   * @returns {Promise<Object>} User entitlements (with defaults if not found)
   */
  async getWithDefaults(userId) {
    const entitlements = await this.get(userId);
    
    if (!entitlements) {
      return {
        userId,
        plan: 'free',
        status: 'none',
        provider: 'paddle',
        meta: {},
        updatedAt: new Date().toISOString()
      };
    }
    
    return entitlements;
  }

  /**
   * Check if user has access to a specific feature based on plan
   * @param {string} userId - Clerk user ID
   * @param {string} feature - Feature to check: 'basic' | 'pro' | 'business'
   * @returns {Promise<boolean>} True if user has access
   */
  async hasAccess(userId, feature = 'basic') {
    try {
      const entitlements = await this.getWithDefaults(userId);
      
      // Check if subscription is active (for paid plans)
      const hasActiveSubscription = ['trialing', 'active'].includes(entitlements.status);
      
      switch (feature) {
        case 'basic':
          return true; // Everyone has basic access
        case 'pro':
          return entitlements.plan === 'pro' && hasActiveSubscription ||
                 entitlements.plan === 'business' && hasActiveSubscription;
        case 'business':
          return entitlements.plan === 'business' && hasActiveSubscription;
        default:
          return false;
      }
    } catch (error) {
      this.logger.error('Failed to check user access', {
        userId,
        feature,
        error: error.message
      });
      return false; // Fail closed - deny access on error
    }
  }

  /**
   * Delete user entitlements
   * @param {string} userId - Clerk user ID
   * @returns {Promise<void>}
   */
  async delete(userId) {
    try {
      if (!userId) {
        throw new Error('User ID is required');
      }

      await this.entitlementsKV.delete(userId);
      
      this.logger.info('Deleted user entitlements', { userId });
    } catch (error) {
      this.logger.error('Failed to delete user entitlements', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Validate entitlements data structure
   * @param {Object} entitlements - Entitlements to validate
   * @private
   */
  _validateEntitlements(entitlements) {
    const validPlans = ['free', 'pro', 'business'];
    const validStatuses = ['none', 'trialing', 'active', 'past_due', 'canceled'];
    const validProviders = ['paddle'];

    if (!validPlans.includes(entitlements.plan)) {
      throw new Error(`Invalid plan: ${entitlements.plan}. Must be one of: ${validPlans.join(', ')}`);
    }

    if (!validStatuses.includes(entitlements.status)) {
      throw new Error(`Invalid status: ${entitlements.status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    if (!validProviders.includes(entitlements.provider)) {
      throw new Error(`Invalid provider: ${entitlements.provider}. Must be one of: ${validProviders.join(', ')}`);
    }
  }
}