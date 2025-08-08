export async function getChatCompletion(messages, apiKey, logger) {
  logger.debug('Requesting chat completion from OpenAI', { messageCount: messages.length });
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
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
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    logger.error('OpenAI chat completion failed', { 
      status: response.status,
      error: errorData 
    });
    throw new Error(`OpenAI API error: ${errorData.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();
  const completion = data.choices[0]?.message?.content || '';
  
  logger.info('Chat completion received', { 
    completionLength: completion.length,
    tokensUsed: data.usage?.total_tokens || 0
  });
  
  return completion;
}