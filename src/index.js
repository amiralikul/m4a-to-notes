import Logger from './logger.js';
import { handleTelegramUpdate } from './handlers/telegram.js';
import { handleApiRequest } from './handlers/api.js';

export default {
  async fetch(request, env) {
    const logger = new Logger(env.LOG_LEVEL || 'INFO');
    const requestId = crypto.randomUUID();
    
    logger.logRequest(request, { requestId });
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Route API requests to API handler
    if (path.startsWith('/api/')) {
      return await handleApiRequest(request, env);
    }
    
    // Handle Telegram webhook (POST to root path)
    if (request.method === 'POST' && path === '/') {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        
        logger.info('Telegram webhook processed successfully', { requestId });
        return new Response('OK', { status: 200 });
      } catch (error) {
        logger.error('Telegram webhook processing failed', { 
          requestId,
          error: error.message,
          stack: error.stack
        });
        return new Response('Error', { status: 500 });
      }
    }

    // Health check for root GET requests
    logger.info('Health check request', { requestId, path });
    return new Response('M4A Transcriber Bot is running!', { 
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};