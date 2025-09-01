/**
 * Simple API Handler Example
 * Shows clean separation without over-engineering
 */
import { HonoContext } from '../types';
import { createServices } from '../services/serviceFactory';
import { getErrorMessage } from '../utils/errors';

/**
 * Simple transcription handler using service factory
 * Clean and testable without complex DI container
 */
export async function handleSimpleTranscription(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');

  try {
    // Create services for this request (simple DI)
    const services = createServices(c.env, logger);

    // Get form data
    const formData = await c.req.formData();
    const audioFile = formData.get('audio');
    
    if (!audioFile || typeof audioFile === 'string') {
      return c.json({
        error: 'No audio file provided',
        requestId
      }, 400);
    }

    // Business logic is now in the orchestrator
    const audioBuffer = await audioFile.arrayBuffer();
    const result = await services.transcriptionOrchestrator.createJob({
      audioBuffer,
      fileName: audioFile.name || 'audio.m4a',
      source: 'web'
    });

    return c.json({
      jobId: result.jobId,
      status: 'queued',
      estimatedDuration: result.estimatedDuration,
      requestId
    });

  } catch (error) {
    logger.error('Transcription request failed', {
      requestId,
      error: getErrorMessage(error)
    });

    return c.json({
      error: getErrorMessage(error),
      requestId
    }, 500);
  }
}

/**
 * Get job status using service factory
 */
export async function handleJobStatus(c: HonoContext): Promise<Response> {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  const jobId = c.req.param('jobId');

  try {
    const services = createServices(c.env, logger);
    const job = await services.jobsService.getJobStatus(jobId);

    if (!job) {
      return c.json({
        error: 'Job not found',
        requestId
      }, 404);
    }

    return c.json({
      ...job,
      requestId
    });

  } catch (error) {
    logger.error('Failed to get job status', {
      requestId,
      jobId,
      error: getErrorMessage(error)
    });

    return c.json({
      error: getErrorMessage(error),
      requestId
    }, 500);
  }
}