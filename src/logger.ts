const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
} as const;

type LogLevel = keyof typeof LOG_LEVELS;
type LogMeta = Record<string, any>;

class Logger {
  private level: number;

  constructor(level: LogLevel = 'INFO') {
    this.level = LOG_LEVELS[level] || LOG_LEVELS.INFO;
  }

  private formatMessage(level: LogLevel, message: string, meta: LogMeta = {}): Record<string, any> {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta
    };
  }

  private log(level: LogLevel, message: string, meta: LogMeta = {}): void {
    if (LOG_LEVELS[level] <= this.level) {
      const logEntry = this.formatMessage(level, message, meta);
      console.log(JSON.stringify(logEntry, null, 2));
    }
  }

  error(message: string, meta: LogMeta = {}): void {
    this.log('ERROR', message, meta);
  }

  warn(message: string, meta: LogMeta = {}): void {
    this.log('WARN', message, meta);
  }

  info(message: string, meta: LogMeta = {}): void {
    this.log('INFO', message, meta);
  }

  debug(message: string, meta: LogMeta = {}): void {
    this.log('DEBUG', message, meta);
  }

  // Cloudflare Workers specific methods
  logRequest(request: Request, meta: LogMeta = {}): void {
    this.info('Incoming request', {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      ...meta
    });
  }

  logTelegramUpdate(update: any, meta: LogMeta = {}): void {
    this.info('Telegram update received', {
      updateId: update.update_id,
      chatId: update.message?.chat?.id,
      messageType: this.getMessageType(update.message),
      ...meta
    });
  }

  logFileProcessing(fileInfo: any, meta: LogMeta = {}): void {
    this.info('Processing file', {
      fileId: fileInfo.file_id,
      fileSize: fileInfo.file_size,
      fileName: fileInfo.file_name,
      mimeType: fileInfo.mime_type,
      ...meta
    });
  }

  logTranscriptionRequest(duration: number, meta: LogMeta = {}): void {
    this.info('Whisper API request', {
      duration: `${duration}ms`,
      ...meta
    });
  }

  logTranscriptionResponse(transcriptionLength: number, meta: LogMeta = {}): void {
    this.info('Transcription completed', {
      transcriptionLength,
      ...meta
    });
  }

  private getMessageType(message: any): string {
    if (!message) return 'unknown';
    if (message.audio) return 'audio';
    if (message.voice) return 'voice';
    if (message.document) return 'document';
    if (message.text) return 'text';
    return 'other';
  }
}

export default Logger;