import { transcribeAudio } from '../services/transcription.js';

export async function handleHealthCheck(c) {
  const requestId = c.get('requestId');
  
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    requestId
  });
}

export async function handleTranscription(c) {
  const logger = c.get('logger');
  const requestId = c.get('requestId');
  
  try {
    const formData = await c.req.formData();
    const audioFile = formData.get('audio');
    
    if (!audioFile) {
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
    if (!audioFile.type.includes('audio') && !audioFile.name.toLowerCase().endsWith('.m4a')) {
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
    logger.error('Transcription failed via API', {
      requestId,
      error: error.message,
      stack: error.stack
    });
    
    return c.json({
      error: 'Failed to process audio file. Please try again.',
      requestId
    }, 500);
  }
}