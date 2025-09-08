import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import Logger from './logger';
import { handleHealthCheck, handleGetTranscription, handleGetTranscript, handleUploadAndProcess } from './handlers/api';
import { handleTelegramWebhook } from './handlers/telegram';
import { handleSyncEntitlements, handleGetEntitlements, handleCheckAccess } from './handlers/users';
import { handlePaddleWebhook, handleCustomerPortal, handleSubscriptionCancel } from './handlers/paddle';
import { handleQueueMessage, TranscriptionQueueMessage } from './services/queueConsumer';
import { isAppError, getErrorMessage, getErrorStatusCode } from './utils/errors';
import { handleClerkWebhook } from './handlers/clerk';
// Removed TranscriptionMessageBatch in favor of Cloudflare MessageBatch<TranscriptionQueueMessage>


const app = new Hono<{
  Bindings: Env;
  Variables: {
    requestId: string;
    logger: Logger;
  };
}>();

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
  allowHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret']
}));

// Hono built-in request logging
app.use('*', honoLogger());

// API Routes
app.get('/api/health', handleHealthCheck);

// Single endpoint for upload and process
app.post('/api/upload-and-process', handleUploadAndProcess);

// Transcription routes
app.get('/api/transcriptions/:transcriptionId', handleGetTranscription);
app.get('/api/transcriptions/:transcriptionId/transcript', handleGetTranscript);

// Paddle routes
app.post('/api/webhook/clerk', handleClerkWebhook);
app.post('/api/webhook/paddle', handlePaddleWebhook);
app.post('/api/paddle/portal', handleCustomerPortal);
app.post('/api/paddle/cancel', handleSubscriptionCancel);

// Entitlements routes (internal only)
app.post('/api/entitlements/sync', handleSyncEntitlements);
app.get('/api/entitlements/:userId', handleGetEntitlements);
app.get('/api/entitlements/:userId/access/:feature', handleCheckAccess);

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
app.onError((err: Error, c) => {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  const errorMessage = getErrorMessage(err);
  const statusCode = getErrorStatusCode(err);
  
  logger.error('Unhandled error', { 
    requestId,
    error: errorMessage,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    statusCode
  });
  
  if (c.req.path.startsWith('/api/')) {
    return c.json({ 
      error: isAppError(err) ? errorMessage : 'Internal server error',
      requestId 
    }, statusCode as any);
  }
  
  return c.text(isAppError(err) ? errorMessage : 'Internal Server Error', statusCode as any);
});

export default {
  // Expose Hono's fetch handler
  fetch: async (request, env, ctx) => {
    return await app.fetch(request, env, ctx);
  },
  // Export queue handler for Cloudflare Workers
  async queue(batch: MessageBatch<TranscriptionQueueMessage>, env, ctx): Promise<void> {
    try {
      await handleQueueMessage(batch, env, ctx);
    } catch (error) {
      console.error('Queue handler error:', error);
      throw error;
    }
  },
  // No scheduled tasks needed with canonical sync approach
} satisfies ExportedHandler<Env, TranscriptionQueueMessage>;