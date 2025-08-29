import { transcribeAudio } from '../services/transcription.js';
import { getChatCompletion } from '../services/chat.js';

export function createHandlers(env) {
  return {
    async start(ctx) {
      const chatId = ctx.chat.id;
      ctx.logger.info('Processing /start command', { chatId });
      
      await ctx.reply(`🎙️ *Welcome to M4A Transcriber Bot!*

Send me an M4A audio file and I'll transcribe it using OpenAI's Whisper API.

Just upload your audio file and I'll handle the rest!`, {
        parse_mode: 'Markdown'
      });
    },

    async help(ctx) {
      const chatId = ctx.chat.id;
      ctx.logger.info('Processing /help command', { chatId });
      
      await ctx.reply(`📋 *How to use this bot:*

1. Send me an M4A audio file
2. Wait for processing (this may take a moment)
3. Receive your transcription!

*Supported formats:* M4A
*Max file size:* 25MB (Whisper API limit)

*Commands:*
/start - Start the bot
/help - Show this help message`, {
        parse_mode: 'Markdown'
      });
    },

    async audio(ctx) {
      const chatId = ctx.chat.id;
      const fileInfo = ctx.message.audio || ctx.message.voice;
      
      await handleFileProcessing(ctx, fileInfo, env);
    },

    async document(ctx) {
      const chatId = ctx.chat.id;
      const fileInfo = ctx.message.document;
      
      // Check if document is an audio file
      if (!fileInfo.mime_type || !fileInfo.mime_type.startsWith('audio/')) {
        await ctx.reply('❌ Please send an audio file (M4A format supported).');
        return;
      }
      
      await handleFileProcessing(ctx, fileInfo, env);
    },

    async text(ctx) {
      const chatId = ctx.chat.id;
      const text = ctx.message.text;
      
      // Skip commands
      if (text.startsWith('/')) {
        return;
      }
      
      const conversationService = ctx.conversationService;
      
      try {
        const conversation = await conversationService.getConversation(chatId);
        
        if (conversationService.hasRecentTranscriptions(conversation)) {
          // Store user message
          await conversationService.addUserMessage(chatId, text, ctx.message.message_id);
          
          // Send thinking indicator
          await ctx.reply('🤔 _Thinking..._', { parse_mode: 'Markdown' });
          
          // Get conversation context for LLM
          const contextMessages = conversationService.getContextForLLM(conversation);
          
          try {
            const response = await getChatCompletion(contextMessages, env.OPENAI_API_KEY, ctx.logger);
            await conversationService.addBotResponse(chatId, response);
            await ctx.reply(response);
          } catch (chatError) {
            ctx.logger.error('Failed to get chat completion', { chatId, error: chatError.message });
            const fallbackResponse = '❌ Sorry, I encountered an error processing your question. Please try again.';
            await conversationService.addBotResponse(chatId, fallbackResponse);
            await ctx.reply(fallbackResponse);
          }
        } else {
          // No recent transcriptions, suggest sending audio first
          await ctx.reply('💡 _Send me an audio file first, then you can ask questions about it!_', { 
            parse_mode: 'Markdown' 
          });
        }
      } catch (error) {
        ctx.logger.error('Failed to handle text message', { chatId, error: error.message });
        await ctx.reply('❌ Failed to process your message. Please try again.');
      }
    },

    async unsupported(ctx) {
      await ctx.reply('❌ Please send an audio file (M4A format supported).');
    }
  };
}

async function handleFileProcessing(ctx, fileInfo, env) {
  const chatId = ctx.chat.id;
  
  ctx.logger.info('Processing audio file', { 
    chatId,
    fileId: fileInfo.file_id,
    fileSize: fileInfo.file_size,
    mimeType: fileInfo.mime_type
  });
  
  // Check file size
  if (fileInfo.file_size > 25 * 1024 * 1024) {
    ctx.logger.warn('File too large', { 
      fileSize: fileInfo.file_size,
      chatId,
      limit: 25 * 1024 * 1024
    });
    await ctx.reply('❌ File too large. Maximum size is 25MB.');
    return;
  }

  // Send processing message
  await ctx.reply('⏳ Processing your audio file...');

  try {
    // Get file and download
    const file = await ctx.getFile();
    const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    
    if (!response.ok) {
      throw new Error('Failed to download file');
    }
    
    const audioBuffer = await response.arrayBuffer();
    
    ctx.logger.info('AudioBuffer created from Telegram file', {
      byteLength: audioBuffer.byteLength,
      type: 'ArrayBuffer',
      chatId
    });
    
    // Transcribe audio
    const transcription = await transcribeAudio(audioBuffer, env.OPENAI_API_KEY, ctx.logger);
    
    if (transcription.trim()) {
      ctx.logger.info('Transcription completed successfully', { 
        chatId,
        transcriptionLength: transcription.length
      });
      
      // Store transcription in conversation context
      const conversationService = ctx.conversationService;
      try {
        await conversationService.addTranscription(chatId, transcription, fileInfo.file_id);
      } catch (error) {
        ctx.logger.error('Failed to store transcription in conversation', { chatId, error: error.message });
      }
      
      await ctx.reply(`📝 *Transcription:*

${transcription}

💬 _You can now ask questions about this audio!_`, {
        parse_mode: 'Markdown'
      });
    } else {
      ctx.logger.warn('No speech detected in audio', { chatId, fileId: fileInfo.file_id });
      await ctx.reply('❌ No speech detected in the audio file.');
    }
  } catch (error) {
    ctx.logger.error('Audio processing failed', { 
      chatId,
      fileId: fileInfo.file_id,
      error: error.message,
      stack: error.stack
    });
    await ctx.reply('❌ Failed to process audio file. Please try again.');
  }
}