/**
 * Telegram Service Utilities
 * Helper functions for sending Telegram messages
 */

/**
 * Send a message to a Telegram chat
 * @param {string} chatId - Telegram chat ID
 * @param {string} text - Message text
 * @param {string} botToken - Telegram bot token
 * @returns {Promise<Object>} Telegram API response
 */
export async function sendTelegramMessage(chatId, text, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Telegram API error: ${response.status} - ${errorData}`);
  }

  return await response.json();
}

/**
 * Send a document to a Telegram chat
 * @param {string} chatId - Telegram chat ID
 * @param {string|ArrayBuffer} document - Document content
 * @param {string} fileName - File name
 * @param {string} caption - File caption
 * @param {string} botToken - Telegram bot token
 * @returns {Promise<Object>} Telegram API response
 */
export async function sendTelegramDocument(chatId, document, fileName, caption, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('caption', caption);
  
  // Create a blob from the document content
  const blob = new Blob([document], { type: 'text/plain' });
  formData.append('document', blob, fileName);

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Telegram API error: ${response.status} - ${errorData}`);
  }

  return await response.json();
}