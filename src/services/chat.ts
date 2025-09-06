import OpenAI, { APIConnectionError, APIError , } from 'openai';
import Logger from '../logger';
async function getChatCompletion(messages: any, apiKey: string, logger: Logger) {
  logger.debug('Requesting chat completion from OpenAI', { messageCount: messages.length });
  
  const openai = new OpenAI({
    apiKey: apiKey,
  });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that can answer questions about audio transcriptions. Be concise and helpful in your responses.'
        },
        ...messages
      ],
      max_tokens: 1000,
      temperature: 0.7
    });

    const responseContent = completion.choices[0]?.message?.content || '';
    
    logger.info('Chat completion received', { 
      completionLength: responseContent.length,
      tokensUsed: completion.usage?.total_tokens || 0
    });
    
    return responseContent;
  } catch (error) {
    logger.error('OpenAI chat completion failed', { 
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof APIError ? error.status : undefined
    });
    throw new Error(`OpenAI API error: ${ error instanceof Error ? error.message : String(error) }`);
  }
}

export { getChatCompletion };