import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import Logger from './logger.js';
import { handleTranscription, handleHealthCheck, handleUploads, handleCreateJob, handleGetJob, handleGetTranscript, handleDebugJobs, handleProcessJob, handleCheckFile } from './handlers/api.js';
import { handleTelegramWebhook } from './handlers/telegram.js';
import { handleSyncEntitlements, handleGetEntitlements, handleCheckAccess } from './handlers/users.js';
import { handlePaddleWebhook, handleCustomerPortal, handleSubscriptionCancel } from './handlers/paddle.js';
import { handleQueueMessage } from './services/queueConsumer.js';

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
  allowHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret']
}));

// Hono built-in request logging
app.use('*', honoLogger());

// API Routes
app.get('/api/health', handleHealthCheck);
app.post('/api/transcribe', handleTranscription);

// New async API routes
app.post('/api/uploads', handleUploads);
app.post('/api/jobs', handleCreateJob);
app.post('/api/jobs/', handleCreateJob);

app.get('/api/jobs/:jobId', handleGetJob);
app.get('/api/transcripts/:jobId', handleGetTranscript);

// Paddle routes
app.post('/api/webhook', handlePaddleWebhook);
app.post('/api/paddle/portal', handleCustomerPortal);
app.post('/api/paddle/cancel', handleSubscriptionCancel);

// Entitlements routes (internal only)
app.post('/api/entitlements/sync', handleSyncEntitlements);
app.get('/api/entitlements/:userId', handleGetEntitlements);
app.get('/api/entitlements/:userId/access/:feature', handleCheckAccess);


// Debug routes
app.get('/api/debug/jobs', handleDebugJobs);
app.post('/api/debug/process/:jobId', handleProcessJob);
app.get('/api/debug/file/:objectKey', handleCheckFile);

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

export default {
  // Expose Hono's fetch handler
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // Export queue handler for Cloudflare Workers
  async queue(batch, env, ctx) {
    try {
      await handleQueueMessage(batch, env, ctx);
    } catch (error) {
      console.error('Queue handler error:', error);
      throw error;
    }
  },
  // No scheduled tasks needed with canonical sync approach
};