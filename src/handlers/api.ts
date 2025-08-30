import { transcribeAudio } from '../services/transcription';
import { StorageService } from '../services/storage';
import { JobsService, JobSource } from '../services/jobs';
import { createDatabase } from '../db';
import { HonoContext } from '../types';
import { getErrorMessage } from '../utils/errors';

export async function handleHealthCheck(c: HonoContext): Promise<Response> {
  const requestId = c.get('requestId');
  
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    requestId
  });
}

export async function handleTranscription(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const formData = await c.req.formData();
    const audioFile = formData.get('audio');
    
    if (!audioFile || typeof audioFile === 'string') {
      logger.warn('No audio file provided', { requestId });
      return c.json({
        error: 'No audio file provided',
        requestId
      }, 400);
    }
    
    // Check file size (25MB limit)
    if (audioFile.size > 25 * 1024 * 1024) {
      logger.warn('File too large', {
        fileSize: audioFile.size,
        requestId,
        limit: 25 * 1024 * 1024
      });
      return c.json({
        error: 'File too large. Maximum size is 25MB.',
        requestId
      }, 400);
    }
    
    // Check file type
    if (!audioFile.type.includes('audio') && !(audioFile.name?.toLowerCase().endsWith('.m4a'))) {
      //log
      logger.warn('Invalid file type', {
        fileType: audioFile.type,
        fileName: audioFile.name,
        requestId
      });
      
      return c.json({
        error: 'Invalid file type. Please upload an M4A audio file.',
        requestId
      }, 400);
    }
    
    logger.info('Processing audio file via API', {
      fileName: audioFile.name,
      fileSize: audioFile.size,
      fileType: audioFile.type,
      requestId
    });
    
    // Convert file to array buffer
    const arrayBuffer = await audioFile.arrayBuffer();

    logger.info('ArrayBuffer created', {
      byteLength: arrayBuffer.byteLength,
      type: 'ArrayBuffer',
      requestId
    });
    
    // Transcribe the audio
    const transcription = await transcribeAudio(arrayBuffer, c.env.OPENAI_API_KEY, logger);
    
    if (!transcription.trim()) {
      logger.warn('No speech detected in audio', { requestId, fileName: audioFile.name });
      return c.json({
        error: 'No speech detected in the audio file.',
        requestId
      }, 400);
    }
    
    logger.info('Transcription completed successfully via API', {
      requestId,
      transcriptionLength: transcription.length,
      fileName: audioFile.name
    });
    
    return c.json({
      transcription,
      fileName: audioFile.name,
      fileSize: audioFile.size,
      requestId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error('Transcription failed via API', {
      requestId,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to process audio file. Please try again.',
      requestId
    }, 500);
  }
}

export async function handleUploads(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const body = await c.req.json();
    const { fileName, contentType } = body;
    
    if (!fileName || !contentType) {
      logger.warn('Missing required fields for upload', {
        requestId,
        fileName: !!fileName,
        contentType: !!contentType
      });
      return c.json({
        error: 'fileName and contentType are required',
        requestId
      }, 400);
    }

    // Initialize storage service
    const storage = new StorageService(c.env.M4A_BUCKET, logger, c.env);
    
    // Validate content type
    if (!storage.isValidContentType(contentType)) {
      logger.warn('Invalid content type for upload', {
        requestId,
        contentType,
        fileName
      });
      return c.json({
        error: 'Invalid content type. Only audio files are supported.',
        requestId
      }, 400);
    }

    // Generate presigned upload URL
    const { uploadUrl, objectKey, expiresAt } = await storage.generatePresignedUploadUrl(
      fileName,
      contentType,
      3600 // 1 hour expiration
    );

    logger.info('Generated presigned upload URL', {
      requestId,
      fileName,
      objectKey,
      expiresAt
    });

    return c.json({
      uploadUrl,
      objectKey,
      expiresAt,
      requestId
    });

  } catch (error) {
    logger.error('Failed to generate upload URL', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Provide more specific error messages for common configuration issues
    let errorMessage = 'Failed to generate upload URL. Please try again.';
    if (getErrorMessage(error).includes('R2 credentials not configured')) {
      errorMessage = 'R2 storage not configured. Please contact support.';
    } else if (getErrorMessage(error).includes('R2 bucket not configured')) {
      errorMessage = 'Storage service unavailable. Please contact support.';
    }
    
    return c.json({
      error: errorMessage,
      requestId
    }, 500);
  }
}

export async function handleCreateJob(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const body = await c.req.json();
    const { objectKey, fileName, source = JobSource.WEB, meta = {} } = body;
    
    if (!objectKey || !fileName) {
      logger.warn('Missing required fields for job creation', {
        requestId,
        objectKey: !!objectKey,
        fileName: !!fileName
      });
      return c.json({
        error: 'objectKey and fileName are required',
        requestId
      }, 400);
    }

    // Initialize database and jobs service
    const db = createDatabase(c.env, logger);
    const jobs = new JobsService(db, logger);
    
    // Create job
    const jobId = await jobs.createJob({
      objectKey,
      fileName,
      source,
      meta: { ...meta, requestId }
    });

    // Enqueue transcription job
    if (c.env.QUEUE) {
      try {
        await c.env.QUEUE.send({
          jobId,
          objectKey,
          fileName,
          source,
          meta: { ...meta, requestId }
        });
        
        logger.info('Job enqueued successfully', {
          requestId,
          jobId,
          objectKey,
          queueName: 'transcribe'
        });
      } catch (queueError) {
        const errorMessage = queueError instanceof Error ? queueError.message : 'Unknown queue error';
        logger.error('Failed to enqueue job', {
          requestId,
          jobId,
          queueError: errorMessage
        });
        throw queueError;
      }
    } else {
      logger.warn('QUEUE not configured, job created but not enqueued', {
        requestId,
        jobId
      });
    }

    logger.info('Job created successfully', {
      requestId,
      jobId,
      objectKey,
      fileName,
      source
    });

    return c.json({
      jobId,
      requestId
    }, 201);

  } catch (error) {
    logger.error('Failed to create job', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to create transcription job. Please try again.',
      requestId
    }, 500);
  }
}

export async function handleGetJob(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');

  try {
    const jobId = c.req.param('jobId');
    
    if (!jobId) {
      return c.json({
        error: 'Job ID is required',
        requestId
      }, 400);
    }

    // Initialize database and jobs service
    const db = createDatabase(c.env, logger);
    const jobs = new JobsService(db, logger);
    
    // Get full job data for debugging
    const fullJob = await jobs.getJob(jobId);
    const jobStatus = await jobs.getJobStatus(jobId);
    
    logger.info('Job status request', {
      requestId,
      jobId,
      fullJobStatus: fullJob?.status,
      fullJobProgress: fullJob?.progress,
      returnedStatus: jobStatus?.status,
      returnedProgress: jobStatus?.progress
    });
    
    if (!jobStatus) {
      logger.warn('Job not found', {
        requestId,
        jobId
      });
      return c.json({
        error: 'Job not found',
        requestId
      }, 404);
    }

    // Add transcript URL if completed
    let transcriptUrl = null;
    if (jobStatus.status === 'completed') {
      const job = await jobs.getJob(jobId);
      if (job && job.meta?.transcription) {
        transcriptUrl = `/api/transcripts/${jobId}`;
      }
    }

    return c.json({
      ...jobStatus,
      transcriptUrl,
      requestId
    });

  } catch (error) {
    logger.error('Failed to get job status', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to get job status. Please try again.',
      requestId
    }, 500);
  }
}

export async function handleDebugJobs(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    // Initialize database and jobs service
    const db = createDatabase(c.env, logger);
    const jobs = new JobsService(db, logger);
    
    // Get all jobs for debugging
    const jobsList = await jobs.getAllJobs(20);

    logger.info('Debug jobs request', {
      requestId,
      jobCount: jobsList.length
    });

    return c.json({
      jobs: jobsList,
      totalJobs: jobsList.length,
      requestId
    });

  } catch (error) {
    logger.error('Failed to get debug jobs', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to get jobs list',
      requestId
    }, 500);
  }
}

export async function handleProcessJob(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const jobId = c.req.param('jobId');
    
    if (!jobId) {
      return c.json({
        error: 'Job ID is required',
        requestId
      }, 400);
    }

    // Get job details
    const db = createDatabase(c.env, logger);
    const jobs = new JobsService(db, logger);
    const job = await jobs.getJob(jobId);
    
    if (!job) {
      return c.json({
        error: 'Job not found',
        requestId
      }, 404);
    }

    if (job.status !== 'queued') {
      return c.json({
        error: `Job is already ${job.status}`,
        requestId
      }, 400);
    }

    // Manually process the job using the queue consumer
    const { TranscriptionQueueConsumer } = await import('../services/queueConsumer.js');
    const consumer = new TranscriptionQueueConsumer(c.env, logger);
    
    logger.info('Manually processing job', {
      requestId,
      jobId,
      fileName: job.fileName
    });

    // Process the job
    await consumer.processTranscriptionJob({
      jobId: job.id,
      objectKey: job.objectKey,
      fileName: job.fileName,
      source: job.source,
      meta: job.meta
    });

    return c.json({
      message: 'Job processed successfully',
      jobId,
      requestId
    });

  } catch (error) {
    logger.error('Failed to process job manually', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to process job: ' + getErrorMessage(error),
      requestId
    }, 500);
  }
}

export async function handleCheckFile(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const objectKey = c.req.param('objectKey').replace('---', '/'); // Replace --- with / for URL safety
    
    const storage = new StorageService(c.env.M4A_BUCKET, logger, c.env);
    const exists = await storage.objectExists(objectKey);
    
    logger.info('File existence check', {
      requestId,
      objectKey,
      exists
    });

    return c.json({
      objectKey,
      exists,
      requestId
    });

  } catch (error) {
    logger.error('Failed to check file existence', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to check file: ' + getErrorMessage(error),
      requestId
    }, 500);
  }
}

export async function handleGetTranscript(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const jobId = c.req.param('jobId');
    
    if (!jobId) {
      return c.json({
        error: 'Job ID is required',
        requestId
      }, 400);
    }

    // Initialize services
    const db = createDatabase(c.env, logger);
    const jobs = new JobsService(db, logger);
    
    // Get job
    const job = await jobs.getJob(jobId);
    
    if (!job) {
      return c.json({
        error: 'Job not found',
        requestId
      }, 404);
    }

    if (job.status !== 'completed') { 
      return c.json({
        error: 'Transcript not available',
        requestId
      }, 404);
    }

    // Get transcript content from meta field (where transcription is stored)
    const transcriptText = job.transcription;

    if (!transcriptText) {
      return c.json({
        error: 'Transcript content not available',
        requestId
      }, 404);
    }

    return c.text(transcriptText, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="transcript-${jobId}.txt"`
    });

  } catch (error) {
    logger.error('Failed to get transcript', {
      requestId,
      error: getErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    return c.json({
      error: 'Failed to get transcript. Please try again.',
      requestId
    }, 500);
  }
}