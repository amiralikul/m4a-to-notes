/**
 * Job Management Service
 * Handles job creation, status tracking, and lifecycle management using KV storage
 */
import { JobData } from '../types';
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
  private kv: KVNamespace;
  private logger: Logger;

  constructor(kvNamespace: KVNamespace, logger: Logger) {
    this.kv = kvNamespace;
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
      const now = new Date().toISOString();

      const job = {
        jobId,
        status: JobStatus.QUEUED,
        progress: 0,
        source,
        objectKey,
        fileName,
        createdAt: now,
        updatedAt: now,
        meta
      };

      await this.kv.put(`job:${jobId}`, JSON.stringify(job));

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
  async getJob(jobId) {
    try {
      const jobData = await this.kv.get(`job:${jobId}`);
      
      if (!jobData) {
        return null;
      }

      return JSON.parse(jobData);
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
  async updateJob(jobId, updates) {
    try {
      const job = await this.getJob(jobId);
      
      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      // Apply updates
      const updatedJob = {
        ...job,
        ...updates,
        updatedAt: new Date().toISOString()
      };

      await this.kv.put(`job:${jobId}`, JSON.stringify(updatedJob));

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
  async markProcessing(jobId, progress = 5) {
    return this.updateJob(jobId, {
      status: JobStatus.PROCESSING,
      progress
    });
  }

  /**
   * Mark job as completed
   * @param {string} jobId - Job ID
   * @param {string} transcriptObjectKey - R2 key for transcript
   * @param {string} transcriptPreview - Short preview of transcript
   * @returns {Promise<Object>} Updated job data
   */
  async markCompleted(jobId, transcriptObjectKey, transcriptPreview = null) {
    return this.updateJob(jobId, {
      status: JobStatus.COMPLETED,
      progress: 100,
      transcriptObjectKey,
      transcriptPreview
    });
  }

  /**
   * Mark job as failed
   * @param {string} jobId - Job ID
   * @param {string} errorCode - Error code
   * @param {string} errorMessage - Error message
   * @returns {Promise<Object>} Updated job data
   */
  async markFailed(jobId, errorCode, errorMessage) {
    return this.updateJob(jobId, {
      status: JobStatus.ERROR,
      error: {
        code: errorCode,
        message: errorMessage
      }
    });
  }

  /**
   * Update job progress
   * @param {string} jobId - Job ID
   * @param {number} progress - Progress percentage (0-100)
   * @returns {Promise<Object>} Updated job data
   */
  async updateProgress(jobId, progress) {
    return this.updateJob(jobId, { progress });
  }

  /**
   * Get jobs by status (for monitoring/cleanup)
   * @param {string} status - Job status to filter by
   * @param {number} limit - Maximum number of jobs to return
   * @returns {Promise<Array>} Array of job objects
   */
  async getJobsByStatus(status, limit = 100) {
    try {
      // Note: This is a simple implementation. For production, consider using D1
      // for better querying capabilities
      const { keys } = await this.kv.list({ prefix: 'job:', limit });
      const jobs = [];

      for (const key of keys) {
        const jobData = await this.kv.get(key.name);
        const job = JSON.parse(jobData);
        
        if (job.status === status) {
          jobs.push(job);
        }
      }

      return jobs;
    } catch (error) {
      this.logger.error('Failed to get jobs by status', {
        status,
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
  async deleteJob(jobId) {
    try {
      await this.kv.delete(`job:${jobId}`);
      
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
  async getJobStatus(jobId) {
    const job = await this.getJob(jobId);
    
    if (!job) {
      return null;
    }

    return {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      fileName: job.fileName,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      transcriptPreview: job.transcriptPreview,
      error: job.error
    };
  }
}