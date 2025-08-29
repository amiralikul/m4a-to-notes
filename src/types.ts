import { Context } from 'hono';
import Logger from './logger';

// Hono Context with Environment Bindings and Variables
export type HonoContext = Context<{
  Bindings: Env;
  Variables: {
    requestId: string;
    logger: Logger;
  };
}>;

// Common interfaces for the application
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  document?: TelegramDocument;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// Job related types
export interface JobData {
  id: string;
  userId: string;
  fileName: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  source: JobSource;
  createdAt: string;
  completedAt?: string;
  transcription?: string;
  error?: string;
}

export enum JobSource {
  TELEGRAM = 'telegram',
  API = 'api'
}

// Paddle webhook types
export interface PaddleWebhook {
  event_type: string;
  data: any;
}

// Storage service types
export interface UploadResult {
  key: string;
  url: string;
}

// Error types
export interface ApiError {
  error: string;
  requestId?: string;
  details?: any;
}

// User entitlements types
export interface UserEntitlements {
  userId: string;
  plan?: string;
  status?: string;
  expiresAt?: string;
  features: string[];
  limits: {
    dailyTranscriptions?: number;
    maxFileSize?: number;
  };
}

// Log metadata type
export type LogMeta = Record<string, any>;