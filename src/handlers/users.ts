import { UsersService } from '../services/users';
import { HonoContext } from '../types';
import { getErrorMessage } from '../utils/errors';

/**
 * Middleware to validate internal API secret
 * @param {Context} c - Hono context
 * @returns {boolean} True if valid, false otherwise
 */
function validateInternalSecret(c: HonoContext): boolean {
  const providedSecret = c.req.header('X-Internal-Secret');
  const expectedSecret = c.env.INTERNAL_API_SECRET;
  
  if (!expectedSecret) {
    c.get('logger').error('INTERNAL_API_SECRET not configured');
    return false;
  }
  
  if (!providedSecret) {
    c.get('logger').warn('Missing X-Internal-Secret header');
    return false;
  }
  
  return providedSecret === expectedSecret;
}

/**
 * Handle syncing user entitlements from Paddle webhooks (internal only)
 * POST /api/entitlements/sync
 */
export async function handleSyncEntitlements(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    // Validate internal API secret
    if (!validateInternalSecret(c)) {
      logger.warn('Unauthorized entitlements sync attempt', { requestId });
      return c.json({
        error: 'Unauthorized',
        requestId
      }, 401);
    }

    const body = await c.req.json();
    const { userId, plan, status, provider = 'paddle', meta = {} } = body;
    
    if (!userId) {
      logger.warn('Missing userId in entitlements sync', { requestId, body });
      return c.json({
        error: 'userId is required',
        requestId
      }, 400);
    }

    // Initialize users service
    const users = new UsersService(c.env.ENTITLEMENTS, logger);
    
    // Update entitlements
    const entitlements = await users.set(userId, {
      plan: plan || 'free',
      status: status || 'none',
      provider,
      meta
    });

    logger.info('Entitlements synced successfully', {
      requestId,
      userId,
      plan: entitlements.plan,
      status: entitlements.status,
      provider: entitlements.provider
    });

    return c.json({
      ok: true,
      entitlements,
      requestId
    });

  } catch (error) {
    logger.error('Failed to sync entitlements', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to sync entitlements',
      requestId
    }, 500);
  }
}

/**
 * Handle getting user entitlements (internal only)
 * GET /api/entitlements/:userId
 */
export async function handleGetEntitlements(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    // Validate internal API secret
    if (!validateInternalSecret(c)) {
      logger.warn('Unauthorized entitlements get attempt', { requestId });
      return c.json({
        error: 'Unauthorized',
        requestId
      }, 401);
    }

    const userId = c.req.param('userId');
    
    if (!userId) {
      return c.json({
        error: 'User ID is required',
        requestId
      }, 400);
    }

    // Initialize users service
    const users = new UsersService(c.env.ENTITLEMENTS, logger);
    console.log({ users });
    
    // Get entitlements with defaults for new users
    const entitlements = await users.getWithDefaults(userId);

    logger.info('Entitlements retrieved', {
      requestId,
      userId,
      plan: entitlements.plan,
      status: entitlements.status
    });

    return c.json({
      entitlements,
      requestId
    });

  } catch (error) {
    logger.error('Failed to get entitlements', {
      requestId,
      userId: c.req.param('userId'),
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to get entitlements',
      requestId
    }, 500);
  }
}

/**
 * Handle checking user access to specific features (internal only)
 * GET /api/entitlements/:userId/access/:feature
 */
export async function handleCheckAccess(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    // Validate internal API secret
    if (!validateInternalSecret(c)) {
      logger.warn('Unauthorized access check attempt', { requestId });
      return c.json({
        error: 'Unauthorized',
        requestId
      }, 401);
    }

    const userId = c.req.param('userId');
    const feature = c.req.param('feature') || 'basic';
    
    if (!userId) {
      return c.json({
        error: 'User ID is required',
        requestId
      }, 400);
    }

    // Initialize users service
    const users = new UsersService(c.env.ENTITLEMENTS, logger);
    
    // Check access
    const hasAccess = await users.hasAccess(userId, feature);

    logger.info('Access check completed', {
      requestId,
      userId,
      feature,
      hasAccess
    });

    return c.json({
      userId,
      feature,
      hasAccess,
      requestId
    });

  } catch (error) {
    logger.error('Failed to check access', {
      requestId,
      userId: c.req.param('userId'),
      feature: c.req.param('feature'),
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to check access',
      requestId
    }, 500);
  }
}