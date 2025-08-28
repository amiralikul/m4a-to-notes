# Payment Sync Refactoring Plan - T3 Style Simplification

## Executive Summary

Transform the current complex queue-based Paddle sync system into T3's simple, centralized approach inspired by [stripe-recommendations](https://github.com/t3dotgg/stripe-recommendations). This refactoring reduces code complexity from ~600 lines across 4 files to ~150 lines in 2 files while maintaining all existing functionality.

## Current Architecture Problems

### Complexity Issues
- **Code Duplication**: Sync logic repeated in 3 places (`paddle.js`, `queueConsumer.js`, `paddleReconciliation.js`)
- **Over-Engineering**: Queue processing for simple webhook events adds unnecessary complexity
- **Multiple Failure Points**: Timeout handlers, retry logic, queue dependencies create maintenance overhead
- **Debugging Difficulty**: Distributed sync logic makes troubleshooting harder

### Files Contributing to Complexity
```
src/handlers/paddle.js          (605 lines) - Webhook handler with queue logic
src/services/paddleReconciliation.js  (332 lines) - Reconciliation service  
src/services/queueConsumer.js   (419 lines) - Queue consumer with Paddle logic
src/handlers/reconciliation.js  (102 lines) - Manual/scheduled reconciliation
Total: ~1,458 lines of payment sync code
```

## Target Architecture (T3 Style)

### Core Philosophy
Following T3's "Do the simplest thing that works" principle:
- **One sync function** called from all necessary places
- **Immediate processing** instead of queue-based async
- **Centralized error handling** in a single location
- **Direct webhook → sync → response** flow

### Simplified Flow
```
Paddle Webhook → Verify Signature → syncPaddleDataToKV() → Response
                                   ↓
                              Update KV Store
```

## Implementation Plan

### Phase 1: Create Centralized Sync Service

**New File: `src/services/paddleSync.js`** (~100 lines)

```javascript
/**
 * Centralized Paddle synchronization service
 * Inspired by T3's syncStripeDataToKV() pattern
 */
export class PaddleSyncService {
  constructor(env, logger) { /* ... */ }
  
  // Main sync function - called from webhooks and manual operations
  async syncPaddleDataToKV(subscription, eventType, context = {}) {
    // All sync logic consolidated here
    // Conflict resolution preserved
    // Metadata mapping preserved
    // Simple, linear flow
  }
  
  // Helper methods for mapping and validation
  mapPaddleToEntitlements(subscription) { /* ... */ }
  detectConflicts(existing, new) { /* ... */ }
}
```

## Canonical State Strategy

### Problem with Event Data
The original plan passes `event.data` directly to sync functions, but this creates several risks:
- **Stale Data**: Webhook events may contain outdated information
- **Partial Payloads**: Events might not include all subscription details
- **Race Conditions**: Multiple webhooks could arrive out of order
- **Delivery Issues**: Webhook retries could cause inconsistent state

### Solution: Fetch Canonical State
Instead of trusting webhook event data, always fetch the current subscription state from Paddle's API.

**Updated Sync Flow:**
```
Paddle Webhook → Extract Subscription ID → Fetch Canonical State → syncPaddleDataToKV() → Response
                                          ↓
                                    GET /subscriptions/{id}
```

### Implementation in PaddleSyncService

```javascript
export class PaddleSyncService {
  constructor(env, logger) {
    this.paddleApiKey = env.PADDLE_API_KEY;
    this.paddleEnvironment = env.PADDLE_ENVIRONMENT || 'sandbox';
    this.logger = logger;
    this.kv = env.ENTITLEMENTS_KV;
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
      
    const response = await fetch(`${baseUrl}/subscriptions/${subscriptionId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.paddleApiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch subscription ${subscriptionId}: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.data; // Return canonical subscription object
  }
  
  /**
   * Main sync function using canonical state
   * @param {string} subscriptionId - Extract from webhook event
   * @param {string} eventType - Webhook event type for context
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
  
  // Existing helper methods use canonical data
  mapPaddleToEntitlements(canonicalSubscription) { /* ... */ }
  detectConflicts(existing, canonical) { /* ... */ }
}
```

### Updated Webhook Handler

```javascript
export async function handlePaddleWebhook(c) {
  const logger = c.get('logger');
  
  // 1. Get webhook data
  const body = await c.req.text();
  const signature = c.req.header('paddle-signature');
  
  // 2. Verify signature
  const webhookSecret = c.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
  if (!(await verifyWebhookSignature(body, signature, webhookSecret))) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  
  // 3. Extract subscription ID from event (don't use event.data)
  const event = JSON.parse(body);
  const subscriptionId = event.data?.id || event.data?.subscription?.id;
  
  if (!subscriptionId) {
    logger.warn('No subscription ID found in webhook', { eventType: event.event_type });
    return c.json({ received: true }); // Ack non-subscription events
  }
  
  // 4. Fetch canonical state and sync
  const syncService = new PaddleSyncService(c.env, logger);
  await syncService.syncPaddleDataToKV(subscriptionId, event.event_type);
  
  return c.json({ received: true });
}
```

### Benefits of Canonical State Approach

**Data Integrity:**
- Always reflects current Paddle state
- Eliminates webhook payload inconsistencies
- Handles race conditions naturally

**Simplified Logic:**
- Single source of truth (Paddle API)
- No need to validate webhook data completeness
- Consistent data structure across all sync operations

**Better Error Handling:**
- API failures are explicit and retryable
- Clear separation between webhook delivery and data sync
- Graceful degradation when Paddle API is unavailable

### Performance Considerations

**API Call Overhead:**
- Additional ~100-200ms per webhook for API call
- Acceptable trade-off for data consistency
- Paddle webhooks are typically infrequent

**Rate Limiting:**
- Paddle API has rate limits, but webhook volume is usually low
- Can add caching layer if needed for high-volume scenarios

### Fallback Strategy

If canonical state fetching fails, the webhook can still acknowledge receipt to prevent retries, but log the failure for manual investigation:

```javascript
try {
  await syncService.syncPaddleDataToKV(subscriptionId, event.event_type);
} catch (error) {
  logger.error('Canonical sync failed, webhook acknowledged', {
    subscriptionId,
    eventType: event.event_type,
    error: error.message
  });
  // Still return success to prevent webhook retries
}
```

### Phase 2: Simplify Webhook Handler

**Update: `src/handlers/paddle.js`** (605 → ~50 lines)

```javascript
export async function handlePaddleWebhook(c) {
  const logger = c.get('logger');
  
  // 1. Get webhook data
  const body = await c.req.text();
  const signature = c.req.header('paddle-signature');
  
  // 2. Verify signature (no longer commented out)
  const webhookSecret = c.env.PADDLE_NOTIFICATION_WEBHOOK_SECRET;
  if (!(await verifyWebhookSignature(body, signature, webhookSecret))) {
    return c.json({ error: 'Invalid signature' }, 401);
  }
  
  // 3. Process immediately (no queue)
  const event = JSON.parse(body);
  const syncService = new PaddleSyncService(c.env, logger);
  await syncService.syncPaddleDataToKV(event.data, event.event_type);
  
  // 4. Simple success response
  return c.json({ received: true });
}
```

### Phase 3: Clean Up Dependencies

**Remove Files:**
- `src/services/paddleReconciliation.js` (332 lines deleted)
- `src/handlers/reconciliation.js` (102 lines deleted)

**Update: `src/services/queueConsumer.js`**
- Remove `PaddleWebhookQueueConsumer` class
- Remove Paddle-related imports
- Keep only transcription logic

**Update: `wrangler.toml`**
- Remove cron trigger: `crons = ["0 2 * * *"]`
- Keep queue configuration for transcription

**Update: `src/index.js`**
- Remove reconciliation route imports
- Remove reconciliation endpoints

### Phase 4: Maintain Core Features

**Preserved Functionality:**
- ✅ Webhook signature verification (enabled)
- ✅ Subscription conflict resolution 
- ✅ Plan hierarchy logic
- ✅ Rich metadata tracking
- ✅ Customer portal URL generation
- ✅ Subscription cancellation via API

**Simplified Patterns:**
- ❌ Queue-based async processing → Direct processing
- ❌ Timeout wrappers → Simple try/catch
- ❌ Scheduled reconciliation → Manual/on-demand only
- ❌ Retry logic → Rely on Paddle webhook retries

## Code Reduction Summary

| Component | Before | After | Reduction |
|-----------|--------|--------|-----------|
| Webhook Handler | 605 lines | ~50 lines | -91% |
| Sync Logic | 3 files, 853 lines | 1 file, ~100 lines | -88% |
| Reconciliation | 434 lines | 0 lines | -100% |
| **Total** | **~1,458 lines** | **~150 lines** | **-90%** |

## Benefits

### Immediate Benefits
- **Faster webhook responses**: No queue overhead
- **Simpler debugging**: One place to look for sync issues
- **Easier testing**: Direct function calls vs queue simulation
- **Reduced infrastructure**: No cron jobs, simpler queue config

### Long-term Benefits  
- **Easier maintenance**: Single sync function to update
- **Better onboarding**: New developers understand flow immediately
- **Flexible deployment**: Can run without queue infrastructure
- **Cost reduction**: Fewer queue messages and cron executions

## Trade-offs

### What We Give Up
- **Webhook burst handling**: High-volume webhook spikes could overwhelm sync
- **Background reconciliation**: No automatic drift detection/correction
- **Advanced retry logic**: Rely on Paddle's webhook retry mechanism
- **Processing isolation**: Webhook failures affect response time

### Risk Mitigation
- **Paddle webhook retries**: Built-in retry mechanism handles temporary failures
- **Manual reconciliation**: Can be triggered via API when needed
- **Monitoring**: Webhook success/failure tracking via logs
- **Graceful degradation**: Sync errors don't break webhook flow

## Implementation Timeline

1. **Day 1**: Create `paddleSync.js` and refactoring plan documentation
2. **Day 1**: Simplify webhook handler and test basic flow
3. **Day 1**: Remove reconciliation files and clean up routes  
4. **Day 1**: Update queue consumer to remove Paddle logic
5. **Day 2**: Integration testing and validation

## Success Metrics

- [ ] Webhook response time < 400ms (including canonical state fetch vs current ~4s timeout)
- [ ] Single file contains all sync logic with canonical state fetching
- [ ] All existing webhook events still processed correctly using Paddle API data
- [ ] Subscription conflicts still resolved properly with canonical state
- [ ] Customer portal and cancellation APIs still functional
- [ ] Data consistency improved: no stale webhook data used for sync operations
- [ ] Clear error separation: webhook delivery vs. data sync failures

## Rollback Plan

If issues arise, the git history contains the full queue-based implementation. Key rollback steps:
1. Restore deleted reconciliation files
2. Re-enable queue processing in webhook handler  
3. Restore cron trigger in `wrangler.toml`
4. Redeploy with previous configuration

---

*This refactoring follows the T3 philosophy: "Make it work, make it simple, then optimize if needed."*