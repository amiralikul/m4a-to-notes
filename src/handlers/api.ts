import { transcribeAudio } from '../services/transcription';
import { StorageService } from '../services/storage';
import { TranscriptionsService, TranscriptionSource } from '../services/transcriptions';
import { createOrGetDatabase } from '../db';
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
    const { objectKey, fileName, source = TranscriptionSource.WEB, meta = {} } = body;
    
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

    // Initialize database and transcriptions service
    const db = createOrGetDatabase(c.env, logger);
    const transcriptions = new TranscriptionsService(db, logger);
    
    // Create transcription
    const transcriptionId = await transcriptions.create({
      audioKey: objectKey,
      filename: fileName,
      source,
      userMetadata: { ...meta, requestId }
    });

    // Enqueue transcription event
    if (c.env.QUEUE) {
      try {
        await c.env.QUEUE.send({
          eventType: 'transcription.requested',
          transcriptionId,
          timestamp: new Date().toISOString()
        });
        
        logger.info('Transcription enqueued successfully', {
          requestId,
          transcriptionId,
          queueName: 'transcribe'
        });
      } catch (queueError) {
        const errorMessage = queueError instanceof Error ? queueError.message : 'Unknown queue error';
        logger.error('Failed to enqueue transcription', {
          requestId,
          transcriptionId,
          queueError: errorMessage
        });
        throw queueError;
      }
    } else {
      logger.warn('QUEUE not configured, transcription created but not enqueued', {
        requestId,
        transcriptionId
      });
    }

    logger.info('Transcription created successfully', {
      requestId,
      transcriptionId,
      filename: fileName,
      source
    });

    return c.json({
      transcriptionId,
      jobId: transcriptionId, // Backward compatibility
      requestId
    }, 201);

  } catch (error) {
    logger.error('Failed to create transcription', {
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

export async function handleGetTranscription(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');

  logger.info('handleGetTranscription called', { 
    url: c.req.url, 
    path: c.req.path,
    requestId 
  });

  try {
    const transcriptionId = c.req.param('transcriptionId');
    
    if (!transcriptionId) {
      return c.json({
        error: 'Transcription ID is required',
        requestId
      }, 400);
    }

    // Initialize database and transcriptions service
    const db = createOrGetDatabase(c.env, logger);
    const transcriptions = new TranscriptionsService(db, logger);
    
    // Get full transcription data for debugging
    const fullTranscription = await transcriptions.findById(transcriptionId);
    const transcriptionStatus = await transcriptions.getStatus(transcriptionId);
    
    logger.info('Transcription status request', {
      requestId,
      transcriptionId,
      fullStatus: fullTranscription?.status,
      fullProgress: fullTranscription?.progress,
      returnedStatus: transcriptionStatus?.status,
      returnedProgress: transcriptionStatus?.progress
    });
    
    if (!transcriptionStatus) {
      logger.warn('Transcription not found', {
        requestId,
        transcriptionId
      });
      return c.json({
        error: 'Transcription not found',
        requestId
      }, 404);
    }

    // Add transcript URL if completed
    let transcriptUrl = null;
    if (transcriptionStatus.status === 'completed') {
      const transcription = await transcriptions.findById(transcriptionId);
      if (transcription && transcription.transcriptText) {
        transcriptUrl = `/api/transcriptions/${transcriptionId}/transcript`;
      }
    }

    return c.json({
      ...transcriptionStatus,
      transcriptUrl,
      requestId
    });

  } catch (error) {
    logger.error('Failed to get transcription status', {
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


export async function handleUploadAndProcess(c: HonoContext): Promise<Response> {
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
    
    // File validation
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (audioFile.size > maxSize) {
      logger.warn('File too large', {
        fileSize: audioFile.size,
        requestId,
        limit: maxSize
      });
      return c.json({
        error: 'File too large. Maximum size is 25MB.',
        requestId
      }, 400);
    }
    
    // Check file type
    const validTypes = ["audio/m4a", "audio/mp4", "audio/x-m4a"];
    if (!validTypes.includes(audioFile.type) && !audioFile.name?.toLowerCase().endsWith('.m4a')) {
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
    
    logger.info('Processing upload and process request', {
      fileName: audioFile.name,
      fileSize: audioFile.size,
      fileType: audioFile.type,
      requestId
    });
    
    // Use the existing simple transcription orchestrator
    const { createServices } = await import('../services/serviceFactory.js');
    const services = createServices(c.env, logger);

    // Convert file to array buffer
    const audioBuffer = await audioFile.arrayBuffer();
    
    // Create transcription using orchestrator (this handles upload to R2 and queueing)
    const result = await services.transcriptionOrchestrator.createTranscription({
      audioBuffer,
      filename: audioFile.name || 'audio.m4a',
      source: 'web',
      userMetadata: { requestId }
    });

    logger.info('Upload and process transcription created successfully', {
      requestId,
      transcriptionId: result.transcriptionId,
      estimatedDuration: result.estimatedDuration,
      filename: audioFile.name
    });

    return c.json({
      transcriptionId: result.transcriptionId,
      jobId: result.transcriptionId, // Backward compatibility 
      status: 'pending',
      estimatedDuration: result.estimatedDuration,
      requestId
    }, 201);
    
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error('Upload and process failed', {
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

export async function handleGetTranscript(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const transcriptionId = c.req.param('transcriptionId');
    
    if (!transcriptionId) {
      return c.json({
        error: 'Transcription ID is required',
        requestId
      }, 400);
    }

    // Initialize services
    const db = createOrGetDatabase(c.env, logger);
    const transcriptions = new TranscriptionsService(db, logger);
    
    // Get transcription
    const transcription = await transcriptions.findById(transcriptionId);
    
    if (!transcription) {
      return c.json({
        error: 'Transcription not found',
        requestId
      }, 404);
    }

    if (transcription.status !== 'completed') { 
      return c.json({
        error: 'Transcript not available',
        requestId
      }, 404);
    }

    // Get transcript content from transcription
    const transcriptText = transcription.transcriptText;

    if (!transcriptText) {
      return c.json({
        error: 'Transcript content not available',
        requestId
      }, 404);
    }

    return c.text(transcriptText, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="transcript-${transcriptionId}.txt"`
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