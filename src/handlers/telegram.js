import Logger from '../logger.js';
import { transcribeAudio } from '../services/transcription.js';
import { ConversationService } from '../services/conversation.js';
import { getChatCompletion } from '../services/chat.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

class TelegramBot {
  constructor(token, logger) {
    this.token = token;
    this.api = `${TELEGRAM_API}${token}`;
    this.logger = logger;
  }

  async sendMessage(chatId, text) {
    this.logger.debug('Sending message to Telegram', { chatId, textLength: text.length });
    
    // Telegram message limit is 4096 characters
    const MAX_LENGTH = 4096;
    
    if (text.length <= MAX_LENGTH) {
      return await this.sendSingleMessage(chatId, text);
    }
    
    // Split long messages - account for continuation header
    const continuationHeader = `📝 *(continued X/Y)*\n\n`;
    const adjustedMaxLength = MAX_LENGTH - continuationHeader.length - 20; // Extra buffer
    const messages = this.splitMessage(text, adjustedMaxLength);
    this.logger.info('Splitting long message', { chatId, parts: messages.length, totalLength: text.length });
    
    const results = [];
    for (let i = 0; i < messages.length; i++) {
      const part = messages[i];
      let partText;
      
      if (i === 0) {
        partText = part;
      } else {
        const header = `📝 *(continued ${i + 1}/${messages.length})*\n\n`;
        partText = header + part;
        
        // Double check length
        if (partText.length > MAX_LENGTH) {
          this.logger.warn('Message part still too long after splitting', { 
            partLength: partText.length, 
            maxLength: MAX_LENGTH,
            partIndex: i 
          });
          // Truncate if still too long
          partText = header + part.substring(0, MAX_LENGTH - header.length - 10) + '...';
        }
      }
      
      try {
        const result = await this.sendSingleMessage(chatId, partText);
        results.push(result);
      } catch (error) {
        this.logger.error('Failed to send message part', { 
          partIndex: i, 
          partLength: partText.length,
          error: error.message 
        });
        // Continue with other parts even if one fails
      }
      
      // Small delay between messages to avoid rate limiting
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    return results.length > 0 ? results[0] : null;
  }

  async sendSingleMessage(chatId, text) {
    const response = await fetch(`${this.api}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });
    
    const result = await response.json();
    
    if (!result.ok) {
      this.logger.error('Failed to send Telegram message', { chatId, error: result });
      throw new Error(`Telegram API error: ${result.description}`);
    }
    
    this.logger.debug('Message sent successfully', { chatId, messageId: result.result.message_id });
    return result;
  }

  splitMessage(text, maxLength) {
    const parts = [];
    let currentPart = '';
    
    // Split by sentences first (looking for . ! ? followed by space or end)
    const sentences = text.split(/([.!?]\s+)/);
    
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      
      if ((currentPart + sentence).length <= maxLength) {
        currentPart += sentence;
      } else {
        if (currentPart) {
          parts.push(currentPart.trim());
          currentPart = sentence;
        } else {
          // Single sentence is too long, split by words
          const words = sentence.split(' ');
          for (const word of words) {
            if ((currentPart + ' ' + word).length <= maxLength) {
              currentPart += (currentPart ? ' ' : '') + word;
            } else {
              if (currentPart) {
                parts.push(currentPart.trim());
                currentPart = word;
              } else {
                // Single word is too long, force split
                parts.push(word.substring(0, maxLength - 3) + '...');
                currentPart = '...' + word.substring(maxLength - 3);
              }
            }
          }
        }
      }
    }
    
    if (currentPart) {
      parts.push(currentPart.trim());
    }
    
    return parts.filter(part => part.length > 0);
  }

  async getFile(fileId) {
    this.logger.debug('Getting file URL from Telegram', { fileId });
    
    const response = await fetch(`${this.api}/getFile?file_id=${fileId}`);
    const data = await response.json();
    
    if (data.ok) {
      const fileUrl = `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`;
      this.logger.debug('File URL retrieved', { fileId, filePath: data.result.file_path });
      return fileUrl;
    }
    
    this.logger.error('Failed to get file URL', { fileId, error: data });
    throw new Error('Failed to get file URL');
  }

  async downloadFile(fileUrl) {
    this.logger.debug('Downloading file from Telegram', { fileUrl });
    
    const startTime = Date.now();
    const response = await fetch(fileUrl);
    
    if (!response.ok) {
      this.logger.error('Failed to download file', { fileUrl, status: response.status });
      throw new Error('Failed to download file');
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const duration = Date.now() - startTime;
    
    this.logger.info('File downloaded successfully', { 
      fileSize: arrayBuffer.byteLength,
      duration: `${duration}ms`
    });
    
    return arrayBuffer;
  }
}

// Simple in-memory cache for processed updates and files (per worker instance)
const processedUpdates = new Set();
const processedFiles = new Set();

export async function handleTelegramUpdate(update, env) {
  const logger = new Logger(env.LOG_LEVEL || 'INFO');
  const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, logger);
  const conversationService = new ConversationService(env.CONVERSATIONS, logger);
  
  logger.logTelegramUpdate(update);
  
  // Check for duplicate updates
  const updateId = update.update_id;
  if (processedUpdates.has(updateId)) {
    logger.warn('Duplicate update received, skipping', { updateId });
    return;
  }
  
  // Add to processed set (keep only last 1000 updates to prevent memory issues)
  processedUpdates.add(updateId);
  if (processedUpdates.size > 1000) {
    const firstUpdate = processedUpdates.values().next().value;
    processedUpdates.delete(firstUpdate);
  }
  
  // Helper function to manage processed files cache
  const addProcessedFile = (fileId) => {
    processedFiles.add(fileId);
    if (processedFiles.size > 1000) {
      const firstFile = processedFiles.values().next().value;
      processedFiles.delete(firstFile);
    }
  };
  
  if (update.message) {
    const chatId = update.message.chat.id;
    const message = update.message;
    
    logger.info('Processing message', { 
      chatId, 
      messageId: message.message_id,
      messageType: logger.getMessageType(message),
      updateId
    });

    if (message.text === '/start') {
      try {
        await bot.sendMessage(chatId, `🎙️ *Welcome to M4A Transcriber Bot!*

Send me an M4A audio file and I'll transcribe it using OpenAI's Whisper API.

Just upload your audio file and I'll handle the rest!`);
      } catch (error) {
        logger.error('Failed to send start message', { chatId, error: error.message });
      }
      return;
    }

    if (message.text === '/help') {
      try {
        await bot.sendMessage(chatId, `📋 *How to use this bot:*

1. Send me an M4A audio file
2. Wait for processing (this may take a moment)
3. Receive your transcription!

*Supported formats:* M4A
*Max file size:* 25MB (Whisper API limit)

*Commands:*
/start - Start the bot
/help - Show this help message`);
      } catch (error) {
        logger.error('Failed to send help message', { chatId, error: error.message });
      }
      return;
    }

    if (message.audio || message.voice || message.document) {
      const fileInfo = message.audio || message.voice || message.document;
      
      logger.logFileProcessing(fileInfo);
      
      // Check for duplicate file processing
      if (processedFiles.has(fileInfo.file_id)) {
        logger.warn('Duplicate file processing detected, skipping', { 
          fileId: fileInfo.file_id,
          chatId,
          updateId 
        });
        return;
      }
      
      // Mark file as being processed
      addProcessedFile(fileInfo.file_id);
      
      if (fileInfo.file_size > 25 * 1024 * 1024) {
        logger.warn('File too large', { 
          fileSize: fileInfo.file_size,
          chatId,
          limit: 25 * 1024 * 1024
        });
        try {
          await bot.sendMessage(chatId, '❌ File too large. Maximum size is 25MB.');
        } catch (error) {
          logger.error('Failed to send file size error message', { chatId, error: error.message });
        }
        return;
      }

      try {
        await bot.sendMessage(chatId, '⏳ Processing your audio file...');
      } catch (error) {
        logger.error('Failed to send processing message', { chatId, error: error.message });
      }

      try {
        const fileUrl = await bot.getFile(fileInfo.file_id);
        const audioBuffer = await bot.downloadFile(fileUrl);
        
        const transcription = await transcribeAudio(audioBuffer, env.OPENAI_API_KEY, logger);
        
        if (transcription.trim()) {
          logger.info('Transcription completed successfully', { 
            chatId,
            transcriptionLength: transcription.length
          });
          
          // Store transcription in conversation context
          try {
            await conversationService.addTranscription(chatId, transcription, fileInfo.file_id);
          } catch (error) {
            logger.error('Failed to store transcription in conversation', { chatId, error: error.message });
          }
          
          try {
            await bot.sendMessage(chatId, `📝 *Transcription:*\n\n${transcription}\n\n💬 _You can now ask questions about this audio!_`);
          } catch (error) {
            logger.error('Failed to send transcription message', { chatId, error: error.message });
          }
        } else {
          logger.warn('No speech detected in audio', { chatId, fileId: fileInfo.file_id });
          try {
            await bot.sendMessage(chatId, '❌ No speech detected in the audio file.');
          } catch (error) {
            logger.error('Failed to send no speech message', { chatId, error: error.message });
          }
        }
      } catch (error) {
        logger.error('Audio processing failed', { 
          chatId,
          fileId: fileInfo.file_id,
          error: error.message,
          stack: error.stack
        });
        try {
          await bot.sendMessage(chatId, '❌ Failed to process audio file. Please try again.');
        } catch (sendError) {
          logger.error('Failed to send error message', { chatId, error: sendError.message });
        }
      }
    } else if (message.text && !message.text.startsWith('/')) {
      // Handle text messages as potential chat questions about transcriptions
      try {
        const conversation = await conversationService.getConversation(chatId);
        
        if (conversationService.hasRecentTranscriptions(conversation)) {
          // Store user message
          await conversationService.addUserMessage(chatId, message.text, message.message_id);
          
          // Send typing indicator
          await bot.sendMessage(chatId, '🤔 _Thinking..._');
          
          // Get conversation context for LLM
          const contextMessages = conversationService.getContextForLLM(conversation);
          
          try {
            const response = await getChatCompletion(contextMessages, env.OPENAI_API_KEY, logger);
            await conversationService.addBotResponse(chatId, response);
            await bot.sendMessage(chatId, response);
          } catch (chatError) {
            logger.error('Failed to get chat completion', { chatId, error: chatError.message });
            const fallbackResponse = '❌ Sorry, I encountered an error processing your question. Please try again.';
            await conversationService.addBotResponse(chatId, fallbackResponse);
            await bot.sendMessage(chatId, fallbackResponse);
          }
        } else {
          // No recent transcriptions, suggest sending audio first
          await bot.sendMessage(chatId, '💡 _Send me an audio file first, then you can ask questions about it!_');
        }
      } catch (error) {
        logger.error('Failed to handle text message', { chatId, error: error.message });
        try {
          await bot.sendMessage(chatId, '❌ Failed to process your message. Please try again.');
        } catch (sendError) {
          logger.error('Failed to send error message', { chatId, error: sendError.message });
        }
      }
    } else {
      try {
        await bot.sendMessage(chatId, '❌ Please send an audio file (M4A format supported).');
      } catch (error) {
        logger.error('Failed to send invalid file message', { chatId, error: error.message });
      }
    }
  }
}