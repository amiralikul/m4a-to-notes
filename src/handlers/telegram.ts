import { handleWebhook } from '../bot/index';
import { HonoContext } from '../types';
import { getErrorMessage } from '../utils/errors';

export async function handleTelegramWebhook(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const update = await c.req.json();
    await handleWebhook(update, c.env, logger, requestId);
    
    return c.text('OK', 200);
  } catch (error) {
    logger.error('Telegram webhook processing failed', { 
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return c.text('Error', 500);
  }
}