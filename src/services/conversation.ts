export class ConversationService {
  constructor(kv, logger) {
    this.kv = kv;
    this.logger = logger;
  }

  getConversationKey(chatId) {
    return `chat_${chatId}`;
  }

  async getConversation(chatId) {
    const key = this.getConversationKey(chatId);
    try {
      const data = await this.kv.get(key, 'json');
      if (data) {
        this.logger.debug('Retrieved conversation context', { 
          chatId, 
          messageCount: data.messages?.length || 0 
        });
        return data;
      }
      return this.createNewConversation();
    } catch (error) {
      this.logger.error('Failed to retrieve conversation', { chatId, error: error.message });
      return this.createNewConversation();
    }
  }

  createNewConversation() {
    return {
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async saveConversation(chatId, conversation) {
    const key = this.getConversationKey(chatId);
    conversation.updatedAt = new Date().toISOString();
    
    try {
      await this.kv.put(key, JSON.stringify(conversation), {
        expirationTtl: 7 * 24 * 60 * 60 // 7 days TTL
      });
      this.logger.debug('Saved conversation context', { 
        chatId, 
        messageCount: conversation.messages?.length || 0 
      });
    } catch (error) {
      this.logger.error('Failed to save conversation', { chatId, error: error.message });
      throw error;
    }
  }

  async addTranscription(chatId, transcription, audioFileId) {
    const conversation = await this.getConversation(chatId);
    
    const message = {
      id: Date.now().toString(),
      type: 'transcription',
      content: transcription,
      audioFileId: audioFileId,
      timestamp: new Date().toISOString()
    };

    conversation.messages.push(message);
    await this.saveConversation(chatId, conversation);
    
    this.logger.info('Added transcription to conversation', { 
      chatId, 
      messageId: message.id,
      transcriptionLength: transcription.length
    });

    return message;
  }

  async addUserMessage(chatId, text, messageId) {
    const conversation = await this.getConversation(chatId);
    
    const message = {
      id: messageId.toString(),
      type: 'user_message',
      content: text,
      timestamp: new Date().toISOString()
    };

    conversation.messages.push(message);
    await this.saveConversation(chatId, conversation);
    
    this.logger.info('Added user message to conversation', { 
      chatId, 
      messageId: message.id
    });

    return message;
  }

  async addBotResponse(chatId, response) {
    const conversation = await this.getConversation(chatId);
    
    const message = {
      id: Date.now().toString(),
      type: 'bot_response',
      content: response,
      timestamp: new Date().toISOString()
    };

    conversation.messages.push(message);
    await this.saveConversation(chatId, conversation);
    
    this.logger.info('Added bot response to conversation', { 
      chatId, 
      messageId: message.id
    });

    return message;
  }

  async clearConversation(chatId) {
    const key = this.getConversationKey(chatId);
    try {
      await this.kv.delete(key);
      this.logger.info('Cleared conversation context', { chatId });
    } catch (error) {
      this.logger.error('Failed to clear conversation', { chatId, error: error.message });
      throw error;
    }
  }

  hasRecentTranscriptions(conversation, maxAgeMs = 30 * 60 * 1000) {
    if (!conversation.messages || conversation.messages.length === 0) {
      return false;
    }

    const now = Date.now();
    const recentTranscriptions = conversation.messages.filter(msg => {
      if (msg.type !== 'transcription') return false;
      const msgTime = new Date(msg.timestamp).getTime();
      return (now - msgTime) <= maxAgeMs;
    });

    return recentTranscriptions.length > 0;
  }

  getContextForLLM(conversation, maxMessages = 10) {
    if (!conversation.messages || conversation.messages.length === 0) {
      return [];
    }

    const recentMessages = conversation.messages
      .slice(-maxMessages)
      .map(msg => {
        switch (msg.type) {
          case 'transcription':
            return {
              role: 'user',
              content: `[Audio Transcription]: ${msg.content}`
            };
          case 'user_message':
            return {
              role: 'user',
              content: msg.content
            };
          case 'bot_response':
            return {
              role: 'assistant',
              content: msg.content
            };
          default:
            return null;
        }
      })
      .filter(Boolean);

    return recentMessages;
  }
}