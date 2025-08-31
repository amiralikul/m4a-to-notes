import { ConversationService } from '../services/conversation.js';
import { createOrGetDatabase } from '../db';

export function createMiddleware(env: Env, logger: any) {
  const db = createOrGetDatabase(env, logger);
  return {
    // Logging middleware
    loggingMiddleware: (ctx, next) => {
      // Attach logger to context
      ctx.logger = logger;
      
      const update = ctx.update;
      logger.logTelegramUpdate(update);
      
      if (ctx.message) {
        const chatId = ctx.chat.id;
        logger.info('Processing message', { 
          chatId, 
          messageId: ctx.message.message_id,
          messageType: logger.getMessageType(ctx.message),
          updateId: update.update_id
        });
      }
      
      return next();
    },

    // Conversation service middleware
    conversationMiddleware: (ctx, next) => {
      // Attach conversation service to context
      ctx.conversationService = new ConversationService(db, logger);
      return next();
    }
  };
}