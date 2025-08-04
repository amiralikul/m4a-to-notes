import { OpenAI } from 'openai';
import Logger from './logger.js';

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
    
    // Split long messages
    const messages = this.splitMessage(text, MAX_LENGTH);
    this.logger.info('Splitting long message', { chatId, parts: messages.length, totalLength: text.length });
    
    const results = [];
    for (let i = 0; i < messages.length; i++) {
      const part = messages[i];
      const partText = i === 0 ? part : `📝 *(continued ${i + 1}/${messages.length})*\n\n${part}`;
      const result = await this.sendSingleMessage(chatId, partText);
      results.push(result);
      
      // Small delay between messages to avoid rate limiting
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    return results[0]; // Return first message result
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

async function transcribeAudio(audioBuffer, openaiKey, logger) {
  const openai = new OpenAI({ apiKey: openaiKey });
  
  logger.info('Starting transcription', { 
    audioSize: audioBuffer.byteLength,
    audioSizeMB: (audioBuffer.byteLength / 1024 / 1024).toFixed(2)
  });
  
  const startTime = Date.now();
  
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], 'audio.m4a', { type: 'audio/m4a' }),
      model: 'whisper-1',
    });
    
    const duration = Date.now() - startTime;
    
    logger.logTranscriptionResponse(transcription.text.length, {
      duration: `${duration}ms`,
      transcriptionPreview: transcription.text.substring(0, 100) + '...'
    });
    
    return transcription.text;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Transcription failed', { 
      error: error.message,
      duration: `${duration}ms`,
      audioSize: audioBuffer.byteLength
    });
    throw new Error('Failed to transcribe audio');
  }
}

async function handleTelegramUpdate(update, env) {
  const logger = new Logger(env.LOG_LEVEL || 'INFO');
  const bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, logger);
  
  logger.logTelegramUpdate(update);
  
  if (update.message) {
    const chatId = update.message.chat.id;
    const message = update.message;
    
    logger.info('Processing message', { 
      chatId, 
      messageId: message.message_id,
      messageType: logger.getMessageType(message)
    });

    if (message.text === '/start') {
      await bot.sendMessage(chatId, `🎙️ *Welcome to M4A Transcriber Bot!*

Send me an M4A audio file and I'll transcribe it using OpenAI's Whisper API.

Just upload your audio file and I'll handle the rest!`);
      return;
    }

    if (message.text === '/help') {
      await bot.sendMessage(chatId, `📋 *How to use this bot:*

1. Send me an M4A audio file
2. Wait for processing (this may take a moment)
3. Receive your transcription!

*Supported formats:* M4A
*Max file size:* 25MB (Whisper API limit)

*Commands:*
/start - Start the bot
/help - Show this help message`);
      return;
    }

    if (message.audio || message.voice || message.document) {
      const fileInfo = message.audio || message.voice || message.document;
      
      logger.logFileProcessing(fileInfo);
      
      if (fileInfo.file_size > 25 * 1024 * 1024) {
        logger.warn('File too large', { 
          fileSize: fileInfo.file_size,
          chatId,
          limit: 25 * 1024 * 1024
        });
        await bot.sendMessage(chatId, '❌ File too large. Maximum size is 25MB.');
        return;
      }

      await bot.sendMessage(chatId, '⏳ Processing your audio file...');

      try {
        const fileUrl = await bot.getFile(fileInfo.file_id);
        const audioBuffer = await bot.downloadFile(fileUrl);
        
        const transcription = await transcribeAudio(audioBuffer, env.OPENAI_API_KEY, logger);
        
        if (transcription.trim()) {
          logger.info('Transcription completed successfully', { 
            chatId,
            transcriptionLength: transcription.length
          });
          await bot.sendMessage(chatId, `📝 *Transcription:*\n\n${transcription}`);
        } else {
          logger.warn('No speech detected in audio', { chatId, fileId: fileInfo.file_id });
          await bot.sendMessage(chatId, '❌ No speech detected in the audio file.');
        }
      } catch (error) {
        logger.error('Audio processing failed', { 
          chatId,
          fileId: fileInfo.file_id,
          error: error.message,
          stack: error.stack
        });
        await bot.sendMessage(chatId, '❌ Failed to process audio file. Please try again.');
      }
    } else {
      await bot.sendMessage(chatId, '❌ Please send an audio file (M4A format supported).');
    }
  }
}

export default {
  async fetch(request, env) {
    const logger = new Logger(env.LOG_LEVEL || 'INFO');
    const requestId = crypto.randomUUID();
    
    logger.logRequest(request, { requestId });
    
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        
        logger.info('Request processed successfully', { requestId });
        return new Response('OK', { status: 200 });
      } catch (error) {
        logger.error('Webhook processing failed', { 
          requestId,
          error: error.message,
          stack: error.stack
        });
        return new Response('Error', { status: 500 });
      }
    }

    logger.info('Health check request', { requestId });
    return new Response('M4A Transcriber Bot is running!', { status: 200 });
  }
};