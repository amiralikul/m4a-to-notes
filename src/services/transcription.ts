import { OpenAI } from 'openai';
import Logger from '../logger';
import { TranscriptionError, getErrorMessage } from '../utils/errors';

export async function transcribeAudio(audioBuffer: ArrayBuffer, openaiKey: string, logger: Logger): Promise<string> {
  const openai = new OpenAI({ apiKey: openaiKey });
  
  logger.info('Starting transcription', { 
    audioSize: audioBuffer.byteLength,
    audioSizeMB: (audioBuffer.byteLength / 1024 / 1024).toFixed(2)
  });
  
  const startTime = Date.now();
  
  try {

    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], 'audio.m4a', { type: 'audio/m4a' }),
      model: 'whisper-1',
    });
    
    const duration = Date.now() - startTime;
    
    logger.logTranscriptionResponse(transcription.text.length, {
      duration: `${duration}ms`,
      transcriptionPreview: transcription.text.substring(0, 100) + '...'
    });
    
    return transcription.text;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = getErrorMessage(error);
    
    // Enhanced error logging for better debugging
    const errorDetails: any = {
      error: errorMessage,
      duration: `${duration}ms`,
      audioSize: audioBuffer.byteLength,
      audioSizeMB: (audioBuffer.byteLength / 1024 / 1024).toFixed(2),
      model: 'whisper-1'
    };

    // Add OpenAI-specific error details if available
    if (error && typeof error === 'object' && 'status' in error) {
      errorDetails.openaiStatus = (error as any).status;
    }
    if (error && typeof error === 'object' && 'code' in error) {
      errorDetails.openaiCode = (error as any).code;
    }
    if (error && typeof error === 'object' && 'type' in error) {
      errorDetails.openaiType = (error as any).type;
    }

    logger.error('Transcription failed', errorDetails);
    throw new TranscriptionError(`Failed to transcribe audio: ${errorMessage}`);
  }
}