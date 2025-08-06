import Logger from '../logger.js';
import { transcribeAudio } from '../services/transcription.js';

export async function handleApiRequest(request, env) {
  const logger = new Logger(env.LOG_LEVEL || 'INFO');
  const requestId = crypto.randomUUID();
  
  logger.logRequest(request, { requestId });
  
  const url = new URL(request.url);
  const path = url.pathname;
  
  // Enable CORS for all API endpoints
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  
  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, { 
      status: 200, 
      headers: corsHeaders 
    });
  }
  
  try {
    if (path === '/api/transcribe' && request.method === 'POST') {
      return await handleTranscribeRequest(request, env, logger, requestId);
    }
    
    if (path === '/api/health') {
      return new Response(JSON.stringify({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        requestId 
      }), { 
        status: 200, 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }
    
    // API endpoint not found
    logger.warn('API endpoint not found', { path, method: request.method, requestId });
    return new Response(JSON.stringify({ 
      error: 'Endpoint not found',
      requestId 
    }), { 
      status: 404, 
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
    
  } catch (error) {
    logger.error('API request failed', { 
      requestId,
      path,
      error: error.message,
      stack: error.stack
    });
    
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      requestId 
    }), { 
      status: 500, 
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  }
}

async function handleTranscribeRequest(request, env, logger, requestId) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');
    
    if (!audioFile) {
      logger.warn('No audio file provided', { requestId });
      return new Response(JSON.stringify({ 
        error: 'No audio file provided',
        requestId 
      }), { 
        status: 400, 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }
    
    // Check file size (25MB limit)
    if (audioFile.size > 25 * 1024 * 1024) {
      logger.warn('File too large', { 
        fileSize: audioFile.size,
        requestId,
        limit: 25 * 1024 * 1024
      });
      return new Response(JSON.stringify({ 
        error: 'File too large. Maximum size is 25MB.',
        requestId 
      }), { 
        status: 400, 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }
    
    // Check file type
    if (!audioFile.type.includes('audio') && !audioFile.name.toLowerCase().endsWith('.m4a')) {
      logger.warn('Invalid file type', { 
        fileType: audioFile.type,
        fileName: audioFile.name,
        requestId
      });
      return new Response(JSON.stringify({ 
        error: 'Invalid file type. Please upload an M4A audio file.',
        requestId 
      }), { 
        status: 400, 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
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
    const transcription = await transcribeAudio(arrayBuffer, env.OPENAI_API_KEY, logger);
    
    if (!transcription.trim()) {
      logger.warn('No speech detected in audio', { requestId, fileName: audioFile.name });
      return new Response(JSON.stringify({ 
        error: 'No speech detected in the audio file.',
        requestId 
      }), { 
        status: 400, 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }
    
    logger.info('Transcription completed successfully via API', { 
      requestId,
      transcriptionLength: transcription.length,
      fileName: audioFile.name
    });
    
    return new Response(JSON.stringify({ 
      transcription,
      fileName: audioFile.name,
      fileSize: audioFile.size,
      requestId,
      timestamp: new Date().toISOString()
    }), { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
    
  } catch (error) {
    logger.error('Transcription failed via API', { 
      requestId,
      error: error.message,
      stack: error.stack
    });
    
    return new Response(JSON.stringify({ 
      error: 'Failed to process audio file. Please try again.',
      requestId 
    }), { 
      status: 500, 
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  }
}