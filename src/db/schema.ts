import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Jobs table (replaces JOBS KV namespace) - DEPRECATED: Use transcriptions table
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(), // UUID
  status: text('status', { 
    enum: ['queued', 'processing', 'completed', 'error'] 
  }).notNull(),
  progress: integer('progress').default(0).notNull(),
  source: text('source', { 
    enum: ['web', 'telegram'] 
  }).notNull(),
  objectKey: text('object_key').notNull(),
  fileName: text('file_name').notNull(),
  transcriptObjectKey: text('transcript_object_key'),
  transcriptPreview: text('transcript_preview'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
  meta: text('meta', { mode: 'json' }).$type<Record<string, any>>(),
  transcription: text('transcription'),
});

// Transcriptions table - NEW: Domain-focused table for transcription workflow
export const transcriptions = sqliteTable('transcriptions', {
  id: text('id').primaryKey(), // UUID
  
  // Status & Progress
  status: text('status', { 
    enum: ['pending', 'processing', 'completed', 'failed'] 
  }).notNull(),
  progress: integer('progress').default(0).notNull(),
  
  // Input Data
  audioKey: text('audio_key').notNull(), // R2 object key for audio file
  filename: text('filename').notNull(),   // Original filename
  source: text('source', { 
    enum: ['web', 'telegram'] 
  }).notNull(),
  
  // Output Data  
  transcriptText: text('transcript_text'),     // Full transcription result
  preview: text('preview'),                    // Short preview of transcription
  
  // Metadata
  userMetadata: text('user_metadata', { mode: 'json' }).$type<Record<string, any>>(),
  errorDetails: text('error_details', { mode: 'json' }).$type<{code?: string, message?: string}>(),
  
  // Timestamps
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  startedAt: text('started_at'),               // When processing began
  completedAt: text('completed_at'),           // When processing finished
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`)
});

// Conversations table (replaces CONVERSATIONS KV namespace)  
export const conversations = sqliteTable('conversations', {
  chatId: text('chat_id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<ConversationData>().notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`),
  expiresAt: text('expires_at').notNull()
});

// User entitlements table (replaces ENTITLEMENTS KV namespace)
export const userEntitlements = sqliteTable('user_entitlements', {
  userId: text('user_id').primaryKey(),
  plan: text('plan'),
  status: text('status'),
  expiresAt: text('expires_at'),
  features: text('features', { mode: 'json' }).$type<string[]>().notNull(),
  limits: text('limits', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`)
    .$onUpdate(() => sql`(CURRENT_TIMESTAMP)`)
});

// Type definitions for conversation data
export interface ConversationData {
  messages: Array<{
    id: string;
    type: 'transcription' | 'user_message' | 'bot_response';
    content: string;
    audioFileId?: string;
    timestamp: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

// Type inference exports
export type Job = typeof jobs.$inferSelect;
export type InsertJob = typeof jobs.$inferInsert;
export type UpdateJob = Partial<Omit<Job, 'id'>>;

export type Transcription = typeof transcriptions.$inferSelect;
export type InsertTranscription = typeof transcriptions.$inferInsert;
export type UpdateTranscription = Partial<Omit<Transcription, 'id'>>;

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;
export type UpdateConversation = Partial<Omit<Conversation, 'chatId'>>;

export type UserEntitlement = typeof userEntitlements.$inferSelect;
export type InsertUserEntitlement = typeof userEntitlements.$inferInsert;
export type UpdateUserEntitlement = Partial<Omit<UserEntitlement, 'userId'>>;