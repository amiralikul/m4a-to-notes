import { handleWebhook } from '../bot/index.js';

export async function handleTelegramWebhook(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const update = await c.req.json();
    await handleWebhook(update, c.env, logger, requestId);
    
    return c.text('OK', 200);
  } catch (error) {
    logger.error('Telegram webhook processing failed', { 
      requestId,
      error: error.message,
      stack: error.stack
    });
    return c.text('Error', 500);
  }
}