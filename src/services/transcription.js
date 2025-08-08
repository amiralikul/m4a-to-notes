import { OpenAI } from 'openai';

export async function transcribeAudio(audioBuffer, openaiKey, logger) {
  const openai = new OpenAI({ apiKey: openaiKey });
  
  logger.info('Starting transcription', { 
    audioSize: audioBuffer.byteLength,
    audioSizeMB: (audioBuffer.byteLength / 1024 / 1024).toFixed(2)
  });
  
  const startTime = Date.now();
  
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], 'audio.m4a', { type: 'audio/m4a' }),
      model: 'gpt-4o-mini-transcribe',
    });
    
    const duration = Date.now() - startTime;
    
    logger.logTranscriptionResponse(transcription.text.length, {
      duration: `${duration}ms`,
      transcriptionPreview: transcription.text.substring(0, 100) + '...'
    });
    
    return transcription.text;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Transcription failed', { 
      error: error.message,
      duration: `${duration}ms`,
      audioSize: audioBuffer.byteLength
    });
    throw new Error('Failed to transcribe audio');
  }
}