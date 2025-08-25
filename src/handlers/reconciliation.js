/**
 * Reconciliation Handler
 * Handles manual and scheduled reconciliation between Paddle and local entitlements
 */

import { PaddleReconciliationService } from '../services/paddleReconciliation.js';

/**
 * Handle manual reconciliation trigger
 * GET /api/reconcile
 */
export async function handleManualReconciliation(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    // Check for internal secret to prevent unauthorized access
    const internalSecret = c.req.header('X-Internal-Secret');
    if (!internalSecret || internalSecret !== c.env.INTERNAL_API_SECRET) {
      logger.warn('Unauthorized reconciliation attempt', { requestId });
      return c.json({ 
        error: 'Unauthorized',
        requestId 
      }, 401);
    }

    // Parse query parameters
    const hours = parseInt(c.req.query('hours')) || 48;
    const dryRun = c.req.query('dry_run') === 'true';
    
    logger.info('Starting manual reconciliation', {
      requestId,
      hours,
      dryRun
    });

    // Run reconciliation
    const reconciliationService = new PaddleReconciliationService(c.env, logger);
    const result = await reconciliationService.runReconciliation({ hours, dryRun });
    
    return c.json({
      success: true,
      result,
      requestId
    });

  } catch (error) {
    logger.error('Manual reconciliation failed', {
      requestId,
      error: error.message,
      stack: error.stack
    });
    
    return c.json({
      error: 'Reconciliation failed: ' + error.message,
      requestId
    }, 500);
  }
}

/**
 * Handle scheduled reconciliation (called by cron trigger)
 * This function is exported for use in the main worker
 */
export async function handleScheduledReconciliation(env, ctx) {
  const logger = new (await import('../logger.js')).default(env.LOG_LEVEL || 'INFO');
  
  try {
    logger.info('Starting scheduled reconciliation job');

    // Run reconciliation for last 48 hours (not dry run)
    const reconciliationService = new PaddleReconciliationService(env, logger);
    const result = await reconciliationService.runReconciliation({ 
      hours: 48, 
      dryRun: false 
    });
    
    logger.info('Scheduled reconciliation completed', result);
    
    // If there were errors or significant mismatches, you might want to send alerts
    if (result.errors > 0 || result.mismatchesFound > 5) {
      logger.warn('Reconciliation found significant issues', {
        errors: result.errors,
        mismatches: result.mismatchesFound,
        fixed: result.mismatchesFixed
      });
      
      // TODO: Send alert notification (email, Slack, etc.)
    }
    
    return result;

  } catch (error) {
    logger.error('Scheduled reconciliation failed', {
      error: error.message,
      stack: error.stack
    });
    
    // TODO: Send critical error notification
    throw error;
  }
}