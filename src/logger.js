const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

class Logger {
  constructor(level = 'INFO') {
    this.level = LOG_LEVELS[level] || LOG_LEVELS.INFO;
  }

  formatMessage(level, message, meta = {}) {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta
    };
  }

  log(level, message, meta = {}) {
    if (LOG_LEVELS[level] <= this.level) {
      const logEntry = this.formatMessage(level, message, meta);
      console.log(JSON.stringify(logEntry, null, 2));
    }
  }

  error(message, meta = {}) {
    this.log('ERROR', message, meta);
  }

  warn(message, meta = {}) {
    this.log('WARN', message, meta);
  }

  info(message, meta = {}) {
    this.log('INFO', message, meta);
  }

  debug(message, meta = {}) {
    this.log('DEBUG', message, meta);
  }

  // Cloudflare Workers specific methods
  logRequest(request, meta = {}) {
    this.info('Incoming request', {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      ...meta
    });
  }

  logTelegramUpdate(update, meta = {}) {
    this.info('Telegram update received', {
      updateId: update.update_id,
      chatId: update.message?.chat?.id,
      messageType: this.getMessageType(update.message),
      ...meta
    });
  }

  logFileProcessing(fileInfo, meta = {}) {
    this.info('Processing file', {
      fileId: fileInfo.file_id,
      fileSize: fileInfo.file_size,
      fileName: fileInfo.file_name,
      mimeType: fileInfo.mime_type,
      ...meta
    });
  }

  logTranscriptionRequest(duration, meta = {}) {
    this.info('Whisper API request', {
      duration: `${duration}ms`,
      ...meta
    });
  }

  logTranscriptionResponse(transcriptionLength, meta = {}) {
    this.info('Transcription completed', {
      transcriptionLength,
      ...meta
    });
  }

  getMessageType(message) {
    if (!message) return 'unknown';
    if (message.audio) return 'audio';
    if (message.voice) return 'voice';
    if (message.document) return 'document';
    if (message.text) return 'text';
    return 'other';
  }
}

export default Logger;