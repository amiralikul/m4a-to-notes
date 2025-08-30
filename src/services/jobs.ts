/**
 * Job Management Service
 * Handles job creation, status tracking, and lifecycle management using Turso DB
 */
import { eq } from 'drizzle-orm';
import { Database, jobs, Job, InsertJob, UpdateJob } from '../db';
import Logger from '../logger';

export const JobStatus = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error'
} as const;

export type JobStatusType = typeof JobStatus[keyof typeof JobStatus];

export const JobSource = {
  WEB: 'web',
  TELEGRAM: 'telegram'
} as const;

export type JobSourceType = typeof JobSource[keyof typeof JobSource];

export class JobsService {
  private db: Database;
  private logger: Logger;

  constructor(database: Database, logger: Logger) {
    this.db = database;
    this.logger = logger;
  }

  /**
   * Create a new job
   * @param {Object} jobData - Job data
   * @param {string} jobData.objectKey - R2 object key for the audio file
   * @param {string} jobData.fileName - Original filename
   * @param {string} jobData.source - Job source (web/telegram)
   * @param {Object} jobData.meta - Additional metadata
   * @returns {Promise<string>} Job ID
   */
  async createJob({ objectKey, fileName, source = JobSource.WEB, meta = {} }: {
    objectKey: string;
    fileName: string;
    source?: JobSourceType;
    meta?: Record<string, any>;
  }): Promise<string> {
    try {
      const jobId = crypto.randomUUID();

      const jobData: InsertJob = {
        id: jobId,
        status: JobStatus.QUEUED,
        progress: 0,
        source,
        objectKey,
        fileName,
        meta
      };

      await this.db.insert(jobs).values(jobData);

      this.logger.info('Job created', {
        jobId,
        objectKey,
        fileName,
        source
      });

      return jobId;
    } catch (error) {
      this.logger.error('Failed to create job', {
        objectKey,
        fileName,
        source,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get job by ID
   * @param {string} jobId - Job ID
   * @returns {Promise<Object|null>} Job data or null if not found
   */
  async getJob(jobId: string): Promise<Job | null> {
    try {
      const result = await this.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1);
      
      return result[0] || null;
    } catch (error) {
      this.logger.error('Failed to get job', {
        jobId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update job status and progress
   * @param {string} jobId - Job ID
   * @param {Object} updates - Updates to apply
   * @param {string} updates.status - New status
   * @param {number} updates.progress - Progress percentage (0-100)
   * @param {string} updates.transcriptObjectKey - R2 key for transcript
   * @param {string} updates.transcriptPreview - Short preview of transcript
   * @param {Object} updates.error - Error details
   * @returns {Promise<Object>} Updated job data
   */
  async updateJob(jobId: string, updates: UpdateJob): Promise<Job> {

    this.logger.info('Updating job', {
      jobId,
      updates
    });

    try {
      const job = await this.getJob(jobId);
      
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      const result = await this.db
        .update(jobs)
        .set(updates)
        .where(eq(jobs.id, jobId))
        .returning();

      const updatedJob = result[0];

      this.logger.info('Job updated', {
        jobId,
        status: updatedJob.status,
        progress: updatedJob.progress
      });

      return updatedJob;
    } catch (error) {
      this.logger.error('Failed to update job', {
        jobId,
        updates,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Mark job as processing
   * @param {string} jobId - Job ID
   * @param {number} progress - Initial progress percentage
   * @returns {Promise<Object>} Updated job data
   */
  async markProcessing(jobId: string, progress = 5): Promise<Job> {
    return this.updateJob(jobId, {
      status: JobStatus.PROCESSING,
      progress
    });
  }

  async markCompleted(jobId: string, transcriptObjectKey: string, transcriptPreview: string | null = null, transcription: string): Promise<Job> {
    return this.updateJob(jobId, {
      status: JobStatus.COMPLETED,
      progress: 100,
      transcriptObjectKey,
      transcriptPreview,
      transcription,
    });
  }

  /**
   * Mark job as failed
   * @param {string} jobId - Job ID
   * @param {string} errorCode - Error code
   * @param {string} errorMessage - Error message
   * @returns {Promise<Object>} Updated job data
   */
  async markFailed(jobId: string, errorCode: string, errorMessage: string): Promise<Job> {
    return this.updateJob(jobId, {
      status: JobStatus.ERROR,
      errorCode,
      errorMessage
    });
  }

  /**
   * Update job progress
   * @param {string} jobId - Job ID
   * @param {number} progress - Progress percentage (0-100)
   * @returns {Promise<Object>} Updated job data
   */
  async updateProgress(jobId: string, progress: number): Promise<Job> {
    return this.updateJob(jobId, { progress });
  }

  /**
   * Get jobs by status (for monitoring/cleanup)
   * @param {string} status - Job status to filter by
   * @param {number} limit - Maximum number of jobs to return
   * @returns {Promise<Array>} Array of job objects
   */
  async getJobsByStatus(status: JobStatusType, limit = 100): Promise<Job[]> {
    try {
      const result = await this.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, status))
        .limit(limit)
        .orderBy(jobs.createdAt);

      return result;
    } catch (error) {
      this.logger.error('Failed to get jobs by status', {
        status,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get all jobs for debugging purposes
   * @param {number} limit - Maximum number of jobs to return
   * @returns {Promise<Job[]>} Array of all jobs
   */
  async getAllJobs(limit = 20): Promise<Job[]> {
    try {
      const result = await this.db
        .select()
        .from(jobs)
        .limit(limit)
        .orderBy(jobs.createdAt);

      return result;
    } catch (error) {
      this.logger.error('Failed to get all jobs', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Delete job data (for cleanup)
   * @param {string} jobId - Job ID
   * @returns {Promise<void>}
   */
  async deleteJob(jobId: string): Promise<void> {
    try {
      await this.db
        .delete(jobs)
        .where(eq(jobs.id, jobId));
      
      this.logger.info('Job deleted', { jobId });
    } catch (error) {
      this.logger.error('Failed to delete job', {
        jobId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get job status for client responses
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Client-friendly job status
   */
  async getJobStatus(jobId: string) {
    const job = await this.getJob(jobId);
    
    if (!job) {
      return null;
    }

    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      fileName: job.fileName,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      transcriptPreview: job.transcriptPreview,
      error: job.errorCode ? {
        code: job.errorCode,
        message: job.errorMessage
      } : undefined
    };
  }
}