import { Bot } from 'grammy/web';
import { createHandlers } from './handlers.js';
import { createMiddleware } from './middleware.js';
import { getOrCreateBot } from '../services/botManager.js';
import Logger from '../logger.js';

export function createBot(token: string, env: Env, logger: Logger) {
  const bot = new Bot(token);
  
  // Add custom middleware
  const { loggingMiddleware, conversationMiddleware } = createMiddleware(env, logger);
  bot.use(loggingMiddleware);
  bot.use(conversationMiddleware);
  
  // Add handlers
  const handlers = createHandlers(env);
  
  // Commands
  bot.command('start', handlers.start);
  bot.command('help', handlers.help);
  
  // File handlers
  bot.on('message:audio', handlers.audio);
  bot.on('message:voice', handlers.audio);
  bot.on('message:document', handlers.document);
  
  // Text message handler (for chat with transcriptions)
  bot.on('message:text', handlers.text);
  
  // Default handler for unsupported content
  bot.on('message', handlers.unsupported);
  
  return bot;
}

export async function handleWebhook(update, env, logger, requestId) {
  try {
    const bot = await getOrCreateBot(env.TELEGRAM_BOT_TOKEN, env, logger);
    
    // Process the update (bot is already initialized)
    await bot.handleUpdate(update);
    
    logger.info('Telegram webhook processed successfully', { requestId });
  } catch (error) {
    logger.error('Telegram webhook processing failed', { 
      requestId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}