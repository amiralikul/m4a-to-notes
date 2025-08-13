import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import Logger from './logger.js';
import { handleTelegramWebhook } from './handlers/telegram.js';
import { handleTranscription, handleHealthCheck } from './handlers/api.js';

const app = new Hono();

// Middleware for request ID generation
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

// Logger middleware
app.use('*', async (c, next) => {
  const logger = new Logger(c.env?.LOG_LEVEL || 'INFO');
  c.set('logger', logger);
  
  logger.logRequest(c.req.raw, { requestId: c.get('requestId') });
  await next();
});

// CORS middleware for API routes
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization']
}));

// Hono built-in request logging
app.use('*', honoLogger());

// API Routes
app.get('/api/health', handleHealthCheck);
app.post('/api/transcribe', handleTranscription);

// Telegram webhook route
app.post('/', handleTelegramWebhook);

// Health check for root GET requests
app.get('/', (c) => {
  return c.text('M4A Transcriber Bot is running!', 200, {
    'Access-Control-Allow-Origin': '*'
  });
});

// 404 handler
app.notFound((c) => {
  const logger = c.get('logger');
  logger.warn('Route not found', { 
    path: c.req.path, 
    method: c.req.method, 
    requestId: c.get('requestId') 
  });
  
  if (c.req.path.startsWith('/api/')) {
    return c.json({ 
      error: 'Endpoint not found',
      requestId: c.get('requestId')
    }, 404);
  }
  
  return c.text('Not Found', 404);
});

// Error handler
app.onError((err, c) => {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  logger.error('Unhandled error', { 
    requestId,
    error: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method
  });
  
  if (c.req.path.startsWith('/api/')) {
    return c.json({ 
      error: 'Internal server error',
      requestId 
    }, 500);
  }
  
  return c.text('Internal Server Error', 500);
});

export default app;