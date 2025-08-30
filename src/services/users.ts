/**
 * Users Service
 * Handles user entitlements and subscription management using Turso DB
 */
import { eq } from 'drizzle-orm';
import { Database, userEntitlements, UserEntitlement, InsertUserEntitlement } from '../db';
import Logger from '../logger';

export class UsersService {
  private db: Database;
  private logger: Logger;

  constructor(database: Database, logger: Logger) {
    this.db = database;
    this.logger = logger;
  }

  /**
   * Get user entitlements from database
   * @param {string} userId - Clerk user ID
   * @returns {Promise<UserEntitlement|null>} User entitlements or null if not found
   */
  async get(userId: string): Promise<UserEntitlement | null> {
    try {
      if (!userId) {
        throw new Error('User ID is required');
      }

      const result = await this.db
        .select()
        .from(userEntitlements)
        .where(eq(userEntitlements.userId, userId))
        .limit(1);

      const entitlements = result[0] || null;
      
      if (!entitlements) {
        this.logger.info('No entitlements found for user', { userId });
        return null;
      }
      
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
   * Set user entitlements in database
   * @param {string} userId - Clerk user ID
   * @param {Object} entitlementsData - Entitlements data to store
   * @param {string} entitlementsData.plan - User plan: 'free' | 'pro' | 'business'
   * @param {string} entitlementsData.status - Subscription status: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled'
   * @param {string} entitlementsData.expiresAt - Expiration date ISO string
   * @param {Array<string>} entitlementsData.features - Array of feature names
   * @param {Object} entitlementsData.limits - Usage limits object
   * @returns {Promise<UserEntitlement>} Updated entitlements
   */
  async set(userId: string, entitlementsData: Omit<InsertUserEntitlement, 'userId'>): Promise<UserEntitlement> {
    try {
      if (!userId) {
        throw new Error('User ID is required');
      }

      // Get existing entitlements to merge with new data
      const existing = await this.get(userId);
      
      // Prepare the entitlements object with defaults
      const entitlements: InsertUserEntitlement = {
        userId,
        plan: entitlementsData.plan || 'free',
        status: entitlementsData.status || 'none',
        expiresAt: entitlementsData.expiresAt,
        features: entitlementsData.features || [],
        limits: {
          ...existing?.limits,
          ...entitlementsData.limits
        }
      };

      // Validate plan and status values
      this._validateEntitlements(entitlements);

      const result = await this.db
        .insert(userEntitlements)
        .values(entitlements)
        .onConflictDoUpdate({
          target: userEntitlements.userId,
          set: entitlements
        })
        .returning();

      const savedEntitlements = result[0];

      this.logger.info('Updated user entitlements', {
        userId,
        plan: savedEntitlements.plan,
        status: savedEntitlements.status
      });

      return savedEntitlements;
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
   * @returns {Promise<UserEntitlement>} User entitlements (with defaults if not found)
   */
  async getWithDefaults(userId: string): Promise<UserEntitlement> {
    const entitlements = await this.get(userId);
    
    if (!entitlements) {
      const defaultEntitlements: InsertUserEntitlement = {
        userId,
        plan: 'free',
        status: 'none',
        features: [],
        limits: {}
      };

      return await this.set(userId, defaultEntitlements);
    }
    
    return entitlements;
  }

  /**
   * Check if user has access to a specific feature based on plan
   * @param {string} userId - Clerk user ID
   * @param {string} feature - Feature to check: 'basic' | 'pro' | 'business'
   * @returns {Promise<boolean>} True if user has access
   */
  async hasAccess(userId: string, feature = 'basic'): Promise<boolean> {
    try {
      const entitlements = await this.getWithDefaults(userId);
      
      // Check if subscription is active (for paid plans)
      const hasActiveSubscription = ['trialing', 'active'].includes(entitlements.status || '');
      
      switch (feature) {
        case 'basic':
          return true; // Everyone has basic access
        case 'pro':
          return (entitlements.plan === 'pro' && hasActiveSubscription) ||
                 (entitlements.plan === 'business' && hasActiveSubscription);
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
  async delete(userId: string): Promise<void> {
    try {
      if (!userId) {
        throw new Error('User ID is required');
      }

      await this.db
        .delete(userEntitlements)
        .where(eq(userEntitlements.userId, userId));
      
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
   * @param {InsertUserEntitlement} entitlements - Entitlements to validate
   * @private
   */
  private _validateEntitlements(entitlements: InsertUserEntitlement): void {
    const validPlans = ['free', 'pro', 'business'];
    const validStatuses = ['none', 'trialing', 'active', 'past_due', 'canceled'];

    if (entitlements.plan && !validPlans.includes(entitlements.plan)) {
      throw new Error(`Invalid plan: ${entitlements.plan}. Must be one of: ${validPlans.join(', ')}`);
    }

    if (entitlements.status && !validStatuses.includes(entitlements.status)) {
      throw new Error(`Invalid status: ${entitlements.status}. Must be one of: ${validStatuses.join(', ')}`);
    }
  }
}