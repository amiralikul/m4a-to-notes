# M4A to Notes Transcriber Bot

A Telegram bot that transcribes M4A audio files using OpenAI's Whisper API, deployed on Cloudflare Workers.

## Features

- 🎙️ **Audio Transcription**: Converts M4A audio files to text using OpenAI Whisper
- 💬 **AI Chat**: Ask questions about your transcriptions using GPT-3.5-turbo
- ⚡ **Serverless**: Runs on Cloudflare Workers for fast global performance
- 📱 **Telegram Integration**: Simple bot interface for easy file uploads
- 🔄 **Smart Message Splitting**: Automatically splits long transcriptions into readable parts
- 💾 **Conversation Context**: Maintains chat history with Cloudflare KV storage
- 📊 **Structured Logging**: Comprehensive logging with request tracking
- 🌍 **Multi-language Support**: Whisper supports 99+ languages
- 💰 **Cost Effective**: Pay-per-use pricing with Cloudflare Workers

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Cloudflare account](https://cloudflare.com)
- [Telegram Bot Token](https://core.telegram.org/bots#botfather)
- [OpenAI API Key](https://platform.openai.com/api-keys)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd m4a-to-notes
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit wrangler.toml with your tokens (for development)
   ```

4. **Create KV namespace for conversation storage**
   ```bash
   npx wrangler kv namespace create CONVERSATIONS
   # Copy the namespace ID and update wrangler.toml
   ```

### Development

1. **Start local development server**
   ```bash
   npx wrangler dev --local
   ```

2. **Test the bot locally**
   - Your bot will be available at `http://localhost:8787`
   - For Telegram webhook testing, use Cloudflare Tunnel:
     ```bash
     # Install cloudflared if not already installed
     # macOS: brew install cloudflare/cloudflare/cloudflared
     # Windows/Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
     
     cloudflared tunnel --url http://localhost:8787
     ```
   
   This will give you a public URL like `https://random-words.trycloudflare.com` that tunnels to your local development server.

### Production Deployment

1. **Authenticate with Cloudflare**
   ```bash
   npx wrangler login
   ```

2. **Set production secrets**
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put OPENAI_API_KEY
   ```

3. **Deploy to Cloudflare Workers**
   ```bash
   npx wrangler deploy
   ```

4. **Configure Telegram webhook**
   ```bash
   # For production deployment
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
   -H "Content-Type: application/json" \
   -d '{"url": "https://your-worker-name.your-subdomain.workers.dev"}'
   
   # For local testing with cloudflared tunnel
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
   -H "Content-Type: application/json" \
   -d '{"url": "https://your-tunnel-url.trycloudflare.com"}'
   ```

## Usage

### Basic Audio Transcription

1. **Start the bot**: Send `/start` to your Telegram bot
2. **Upload audio**: Send an M4A audio file (up to 25MB)
3. **Get transcription**: Receive the transcribed text automatically

### AI Chat with Transcriptions

4. **Ask questions**: After transcription, send text messages to ask questions about the audio
5. **Get AI responses**: The bot uses GPT-3.5-turbo to answer based on your transcription context
6. **Multiple audios**: Send more audio files to extend the conversation context

**Example conversation:**
```
👤 [Sends audio file]
🤖 📝 Transcription: "The meeting discussed quarterly sales targets..."

👤 What were the main action items?
🤖 Based on the transcription, the main action items were...

👤 Who was responsible for the Q4 targets?
🤖 According to the discussion, John was assigned...
```

### Supported Commands

- `/start` - Welcome message and instructions
- `/help` - Show help information

### Supported File Types

- **M4A** - Primary format (recommended)
- **Voice messages** - Telegram voice recordings
- **Audio documents** - Various audio formats

## Architecture

### Audio Transcription Flow

```mermaid
sequenceDiagram
    participant U as User
    participant T as Telegram
    participant CW as Cloudflare Worker
    participant KV as Cloudflare KV
    participant OAI as OpenAI Whisper API

    U->>T: Send M4A audio file
    T->>CW: POST webhook with file info
    CW->>CW: Validate file size & format
    CW->>T: Send "Processing..." message
    CW->>T: Download file via getFile API
    CW->>OAI: Send audio to Whisper API
    OAI-->>CW: Return transcription text
    CW->>KV: Store transcription in conversation context
    CW->>CW: Split long messages if needed
    CW->>T: Send transcription + "You can ask questions!" to user
    T->>U: Display transcription
```

### AI Chat Flow

```mermaid
sequenceDiagram
    participant U as User
    participant T as Telegram
    participant CW as Cloudflare Worker
    participant KV as Cloudflare KV
    participant GPT as OpenAI GPT-3.5-turbo

    U->>T: Send text question
    T->>CW: POST webhook with message
    CW->>KV: Get conversation context
    KV-->>CW: Return transcription + chat history
    CW->>T: Send "Thinking..." message
    CW->>GPT: Send context + question to ChatGPT
    GPT-->>CW: Return AI response
    CW->>KV: Store user question + AI response
    CW->>T: Send AI response to user
    T->>U: Display response
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | ✅ |
| `OPENAI_API_KEY` | OpenAI API key (Whisper + GPT-3.5-turbo) | ✅ |
| `CONVERSATIONS` | Cloudflare KV namespace binding | ✅ |
| `LOG_LEVEL` | Logging level (ERROR, WARN, INFO, DEBUG) | ❌ |
| `NODE_ENV` | Environment (development, production) | ❌ |

### Limits

- **File Size**: 25MB (Whisper API limit)
- **Message Length**: 4096 characters (auto-split for longer texts)
- **Processing Time**: ~30-60 seconds for typical audio files
- **Conversation Context**: 30-minute window for chat relevance
- **Context Storage**: 7-day TTL for conversation history

## Logging

The application provides structured JSON logging with:

- **Request tracking** with unique IDs
- **Performance metrics** for downloads and transcriptions
- **Error handling** with full context
- **Telegram API interaction** logs

### Log Levels

- `ERROR`: Failed operations, API errors
- `WARN`: File size limits, no speech detected
- `INFO`: Successful operations, processing status
- `DEBUG`: Detailed API calls, file processing

## Cost Estimation

### Cloudflare Workers
- **Free Tier**: 100,000 requests/day
- **Paid**: $0.50 per million requests

### OpenAI API Costs
- **Whisper**: $0.006 per minute of audio
- **GPT-3.5-turbo**: $0.0015 per 1K input tokens, $0.002 per 1K output tokens
- **Example**: 10-minute audio + 5 chat questions ≈ $0.10

### Cloudflare KV Storage
- **Free Tier**: 1GB storage, 100K reads/day, 1K writes/day
- **Paid**: $0.50 per GB/month, $0.50 per million reads

## Troubleshooting

### Common Issues

1. **"Bot token not found"**
   - Verify `TELEGRAM_BOT_TOKEN` is set correctly
   - Check token format: `123456789:ABCDEF...`

2. **"OpenAI API error"**
   - Verify `OPENAI_API_KEY` is valid
   - Check OpenAI account has sufficient credits

3. **"File too large"**
   - Maximum file size is 25MB
   - Compress audio or use shorter recordings

4. **"No speech detected"**
   - Ensure audio contains clear speech
   - Check audio isn't corrupted or silent

5. **"Send audio file first"**
   - Chat requires recent transcription (30-minute window)
   - Upload audio before asking questions

6. **Chat responses seem unrelated**
   - Conversation context may have expired
   - Send fresh audio to reset context

### Debugging

Enable debug logging:
```bash
npx wrangler secret put LOG_LEVEL
# Enter: DEBUG
```

View logs:
```bash
npx wrangler tail
```

## Development

### Project Structure

```
m4a-to-notes/
├── src/
│   ├── index.js              # Main Cloudflare Worker entry point
│   ├── logger.js             # Structured logging utility
│   ├── handlers/
│   │   └── telegram.js       # Telegram bot logic & message handlers
│   └── services/
│       ├── transcription.js  # OpenAI Whisper integration
│       ├── conversation.js   # KV-based conversation management
│       └── chat.js          # OpenAI GPT-3.5-turbo integration
├── wrangler.toml            # Worker configuration + KV binding
├── package.json
├── .env.example
└── README.md
```

### Adding Features

1. **New Commands**: Add handlers in `telegram.js:handleTelegramUpdate()`
2. **File Formats**: Extend validation in file processing logic
3. **Custom Responses**: Modify message templates in telegram handler
4. **Chat Enhancements**: Extend `ConversationService` methods
5. **AI Model Changes**: Update `chat.js` for different OpenAI models
6. **Storage Options**: Modify conversation retention in KV service

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Commit changes: `git commit -am 'Add new feature'`
4. Push to branch: `git push origin feature/new-feature`
5. Submit a Pull Request

## License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

## Support

- 📖 [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- 🤖 [Telegram Bot API](https://core.telegram.org/bots/api)
- 🎙️ [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text)

## Acknowledgments

- OpenAI for the Whisper API
- Cloudflare for the Workers platform
- Telegram for the Bot API