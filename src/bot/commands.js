const startCommand = (bot) => {
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `
🎙️ Welcome to M4A Transcriber Bot!

Send me an M4A audio file and I'll transcribe it using OpenAI's Whisper API.

Just upload your audio file and I'll handle the rest!
    `;
    bot.sendMessage(chatId, welcomeMessage);
  });
};

const helpCommand = (bot) => {
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
📋 How to use this bot:

1. Send me an M4A audio file
2. Wait for processing (this may take a moment)
3. Receive your transcription!

Supported formats: M4A
Max file size: 25MB (Whisper API limit)

Commands:
/start - Start the bot
/help - Show this help message
    `;
    bot.sendMessage(chatId, helpMessage);
  });
};

module.exports = {
  startCommand,
  helpCommand
};