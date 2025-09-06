/**
 * Transcription Management Service
 * Domain-focused service for transcription workflow management using Turso DB
 * Replaces JobsService with cleaner architecture and improved naming
 */
import { eq } from 'drizzle-orm';
import { Database, transcriptions, Transcription, InsertTranscription, UpdateTranscription } from '../db';
import Logger from '../logger';

export const TranscriptionStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing', 
  COMPLETED: 'completed',
  FAILED: 'failed'
} as const;

export type TranscriptionStatusType = typeof TranscriptionStatus[keyof typeof TranscriptionStatus];

export const TranscriptionSource = {
  WEB: 'web',
  TELEGRAM: 'telegram'
} as const;

export type TranscriptionSourceType = typeof TranscriptionSource[keyof typeof TranscriptionSource];

export class TranscriptionsService {
  private db: Database;
  private logger: Logger;

  constructor(database: Database, logger: Logger) {
    this.db = database;
    this.logger = logger;
  }

  /**
   * Create a new transcription
   * @param {Object} transcriptionData - Transcription data
   * @param {string} transcriptionData.audioKey - R2 object key for the audio file
   * @param {string} transcriptionData.filename - Original filename
   * @param {string} transcriptionData.source - Transcription source (web/telegram)
   * @param {Object} transcriptionData.userMetadata - Additional metadata
   * @returns {Promise<string>} Transcription ID
   */
  async create({ audioKey, filename, source = TranscriptionSource.WEB, userMetadata = {} }: {
    audioKey: string;
    filename: string;
    source?: TranscriptionSourceType;
    userMetadata?: Record<string, any>;
  }): Promise<string> {
    try {
      const transcriptionId = crypto.randomUUID();

      const transcriptionData: InsertTranscription = {
        id: transcriptionId,
        status: TranscriptionStatus.PENDING,
        progress: 0,
        source,
        audioKey,
        filename,
        userMetadata
      };

      await this.db.insert(transcriptions).values(transcriptionData);

      this.logger.info('Transcription created', {
        transcriptionId,
        audioKey,
        filename,
        source
      });

      return transcriptionId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to create transcription', {
        audioKey,
        filename,
        source,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Find transcription by ID
   * @param {string} transcriptionId - Transcription ID
   * @returns {Promise<Object|null>} Transcription data or null if not found
   */
  async findById(transcriptionId: string): Promise<Transcription | null> {
    try {
      const result = await this.db
        .select()
        .from(transcriptions)
        .where(eq(transcriptions.id, transcriptionId))
        .limit(1);
      
      return result[0] || null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to find transcription', {
        transcriptionId,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Update transcription with partial data
   * @param {string} transcriptionId - Transcription ID
   * @param {Object} updates - Updates to apply
   * @returns {Promise<Object>} Updated transcription data
   */
  async update(transcriptionId: string, updates: UpdateTranscription): Promise<Transcription> {
    this.logger.info('Updating transcription', {
      transcriptionId,
      updates: Object.keys(updates)
    });

    try {
      const transcription = await this.findById(transcriptionId);
      
      if (!transcription) {
        throw new Error(`Transcription not found: ${transcriptionId}`);
      }

      const result = await this.db
        .update(transcriptions)
        .set(updates)
        .where(eq(transcriptions.id, transcriptionId))
        .returning();

      const updatedTranscription = result[0];

      this.logger.info('Transcription updated', {
        transcriptionId,
        status: updatedTranscription.status,
        progress: updatedTranscription.progress
      });

      return updatedTranscription;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to update transcription', {
        transcriptionId,
        updates,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Mark transcription as started (processing)
   * @param {string} transcriptionId - Transcription ID
   * @param {number} progress - Initial progress percentage
   * @returns {Promise<Object>} Updated transcription data
   */
  async markStarted(transcriptionId: string, progress = 5): Promise<Transcription> {
    return this.update(transcriptionId, {
      status: TranscriptionStatus.PROCESSING,
      progress,
      startedAt: new Date().toISOString()
    });
  }

  /**
   * Mark transcription as completed
   * @param {string} transcriptionId - Transcription ID
   * @param {string|null} preview - Preview text
   * @param {string} transcriptText - Full transcript text
   * @returns {Promise<Object>} Updated transcription data
   */
  async markCompleted(transcriptionId: string, preview: string | null = null, transcriptText: string): Promise<Transcription> {
    return this.update(transcriptionId, {
      status: TranscriptionStatus.COMPLETED,
      progress: 100,
      preview,
      transcriptText,
      completedAt: new Date().toISOString()
    });
  }

  /**
   * Mark transcription as failed
   * @param {string} transcriptionId - Transcription ID
   * @param {string} errorCode - Error code
   * @param {string} errorMessage - Error message
   * @returns {Promise<Object>} Updated transcription data
   */
  async markFailed(transcriptionId: string, errorCode: string, errorMessage: string): Promise<Transcription> {
    return this.update(transcriptionId, {
      status: TranscriptionStatus.FAILED,
      errorDetails: { code: errorCode, message: errorMessage },
      completedAt: new Date().toISOString()
    });
  }

  /**
   * Update transcription progress
   * @param {string} transcriptionId - Transcription ID
   * @param {number} progress - Progress percentage (0-100)
   * @returns {Promise<Object>} Updated transcription data
   */
  async updateProgress(transcriptionId: string, progress: number): Promise<Transcription> {
    return this.update(transcriptionId, { progress });
  }

  /**
   * Find transcriptions by status (for monitoring/cleanup)
   * @param {string} status - Transcription status to filter by
   * @param {number} limit - Maximum number of transcriptions to return
   * @returns {Promise<Array>} Array of transcription objects
   */
  async findByStatus(status: TranscriptionStatusType, limit = 100): Promise<Transcription[]> {
    try {
      const result = await this.db
        .select()
        .from(transcriptions)
        .where(eq(transcriptions.status, status))
        .limit(limit)
        .orderBy(transcriptions.createdAt);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to find transcriptions by status', {
        status,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Get all transcriptions for debugging purposes
   * @param {number} limit - Maximum number of transcriptions to return
   * @returns {Promise<Transcription[]>} Array of all transcriptions
   */
  async findAll(limit = 20): Promise<Transcription[]> {
    try {
      const result = await this.db
        .select()
        .from(transcriptions)
        .limit(limit)
        .orderBy(transcriptions.createdAt);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to find all transcriptions', {
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Delete transcription data (for cleanup)
   * @param {string} transcriptionId - Transcription ID
   * @returns {Promise<void>}
   */
  async delete(transcriptionId: string): Promise<void> {
    try {
      await this.db
        .delete(transcriptions)
        .where(eq(transcriptions.id, transcriptionId));
      
      this.logger.info('Transcription deleted', { transcriptionId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to delete transcription', {
        transcriptionId,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Get transcription status for client responses
   * @param {string} transcriptionId - Transcription ID  
   * @returns {Promise<Object|null>} Client-friendly transcription status
   */
  async getStatus(transcriptionId: string) {
    const transcription = await this.findById(transcriptionId);
    
    if (!transcription) {
      return null;
    }

    return {
      transcriptionId: transcription.id,
      jobId: transcription.id, // Backward compatibility
      status: transcription.status,
      progress: transcription.progress,
      filename: transcription.filename,
      createdAt: transcription.createdAt,
      startedAt: transcription.startedAt,
      completedAt: transcription.completedAt,
      updatedAt: transcription.updatedAt,
      preview: transcription.preview,
      error: transcription.errorDetails ? {
        code: transcription.errorDetails.code,
        message: transcription.errorDetails.message
      } : undefined
    };
  }
}