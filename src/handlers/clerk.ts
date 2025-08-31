import { createOrGetDatabase } from "../db";
import { PaddleSyncService } from "../services/paddleSync";
import { HonoContext } from "../types";



export async function handleClerkWebhook(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const body = await c.req.text();
    const signature = c.req.header('clerk-signature');
    
    logger.info('Received Clerk webhook', { 
      requestId,
      hasSignature: !!signature
    });

    //TODO: Verify signature
    
    const event = JSON.parse(body);
    console.log('Clerk webhook event', event);


    logger.info('Processing webhook event', {
      requestId,
      eventType: event.event_type,
      eventData: event.data
    });

    //Extract subscription ID from event (don't use event.data)
    const subscriptionId = event.data?.id || event.data?.subscription?.id;

    console.log('subscriptionId', subscriptionId);
    if (!subscriptionId) {
      logger.info('Non-subscription event, acknowledging', { 
        requestId,
        eventType: event.event_type
      });
      return c.json({ received: true, requestId });
    }

    


    
    return c.json({ received: true });
  } catch (error) {
    logger.error('Clerk webhook processing failed', { 
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return c.json({ error: 'Failed to process webhook' }, 500);
  }
  return c.json({ received: true });
}