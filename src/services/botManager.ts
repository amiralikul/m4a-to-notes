import { createBot } from '../bot/index.js';

let botInstance = null;
let currentToken = null;

export async function getOrCreateBot(token, env, logger) {
  // If token changed or no bot exists, create new one
  if (!botInstance || currentToken !== token) {
    logger.info('Creating new bot instance', { tokenChanged: currentToken !== token });
    
    botInstance = createBot(token, env, logger);
    currentToken = token;
    
    // Initialize the bot only once
    await botInstance.init();
    
    logger.info('Bot instance created and initialized');
  }
  
  return botInstance;
}

export function resetBot() {
  botInstance = null;
  currentToken = null;
}