# Async Transcription Setup Guide

This guide will help you set up the new async transcription system that uses R2 storage, Cloudflare Queues, and provides better scalability and user experience.

## Overview

The new async system includes:
- **Direct R2 uploads** via presigned URLs (bypasses Worker size limits)
- **Job queue system** for reliable background processing
- **Real-time status updates** via polling (SSE support coming in Phase 3)
- **Unified pipeline** for both web and Telegram interfaces

## Prerequisites

1. Cloudflare account with Workers, R2, and KV access
2. OpenAI API key
3. Telegram bot token (if using Telegram features)

## Step-by-Step Setup

### 1. Create Cloudflare Resources

#### Create R2 Bucket
```bash
# Create R2 bucket for audio files and transcripts
npx wrangler r2 bucket create m4a-to-notes
```

#### Create KV Namespace for Jobs
```bash
# Create KV namespace for job tracking
npx wrangler kv:namespace create "JOBS"
```

#### Create Queue for Transcription Processing
```bash
# Create queue for background transcription jobs
npx wrangler queues create transcribe
```

### 2. Update wrangler.toml Configuration

Update your `wrangler.toml` with the actual resource IDs:

```toml
name = "m4a-to-notes"
main = "src/index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "CONVERSATIONS"
id = "37462871a7824d94985cbbdcdb4baf08"

[[kv_namespaces]]
binding = "JOBS"
id = "YOUR_JOBS_KV_NAMESPACE_ID"  # Replace with actual ID from step 1

[[r2_buckets]]
binding = "M4A_BUCKET"
bucket_name = "m4a-to-notes"

[[queues.producers]]
binding = "TRANSCRIBE_QUEUE"
queue = "transcribe"

[[queues.consumers]]
queue = "transcribe"
max_batch_size = 5
max_batch_timeout = 30

[vars]
NODE_ENV = "production"
LOG_LEVEL = "INFO"
TELEGRAM_BOT_TOKEN = "your_telegram_bot_token_here"
OPENAI_API_KEY = "your_openai_api_key_here"
```

### 3. Set Environment Secrets

Set your sensitive environment variables as secrets:

```bash
# Set OpenAI API key
npx wrangler secret put OPENAI_API_KEY
# Enter your OpenAI API key when prompted

# Set Telegram bot token (if using Telegram features)
npx wrangler secret put TELEGRAM_BOT_TOKEN
# Enter your Telegram bot token when prompted
```

### 4. Configure R2 Lifecycle Rules (Optional but Recommended)

Set up automatic cleanup for uploaded files to manage storage costs:

```bash
# Create a lifecycle rule to delete audio files after 24 hours
# and transcripts after 7 days (adjust as needed)
```

You can configure this through the Cloudflare dashboard:
1. Go to R2 → m4a-to-notes bucket
2. Settings → Lifecycle rules
3. Add rules for automatic deletion

### 5. Deploy the Application

```bash
# Deploy the Worker with queue consumer
npx wrangler deploy
```

### 6. Test the Setup

#### Test Basic API Endpoints
```bash
# Test health endpoint
curl https://your-worker-domain.workers.dev/api/health

# Test upload endpoint (should fail gracefully if no file provided)
curl -X POST https://your-worker-domain.workers.dev/api/uploads \
  -H "Content-Type: application/json" \
  -d '{"fileName": "test.m4a", "contentType": "audio/m4a"}'
```

#### Test Complete Upload Flow
1. Use the web interface at your frontend domain
2. Upload an M4A file
3. Monitor the job status through the UI
4. Verify transcript download works

## API Endpoints

The new async system provides these endpoints:

### Upload Flow
1. **POST /api/uploads** - Get presigned upload URL
2. **PUT {uploadUrl}** - Upload file directly to R2 (client-side)
3. **POST /api/jobs** - Create transcription job
4. **GET /api/jobs/{jobId}** - Check job status (polling)
5. **GET /api/transcripts/{jobId}** - Download completed transcript

### Legacy Support
- **POST /api/transcribe** - Original synchronous endpoint (still works)

## Frontend Configuration

The frontend has been updated to use the new async flow automatically. No additional configuration needed.

## Monitoring and Troubleshooting

### View Logs
```bash
# View real-time logs
npx wrangler tail

# View logs with filtering
npx wrangler tail --format=pretty --grep="ERROR"
```

### Monitor Queue
```bash
# Check queue status
npx wrangler queues list

# View queue metrics in Cloudflare dashboard
```

### Common Issues

#### 1. "R2 bucket not configured" Error
- Verify the R2 bucket exists and is correctly bound in wrangler.toml
- Check that the bucket name matches exactly

#### 2. "Job not enqueued" Warning
- Verify the queue exists and is correctly configured
- Check queue bindings in wrangler.toml

#### 3. KV Errors
- Ensure the JOBS KV namespace exists and ID is correct
- Check KV namespace bindings

#### 4. Transcription Fails
- Verify OpenAI API key is set correctly
- Check file format and size (must be valid audio, max 25MB)
- Review logs for specific error messages

## Cost Optimization

### R2 Storage Costs
- Audio files: ~$0.015 per GB per month
- Consider lifecycle rules to auto-delete old files

### Queue Processing Costs
- Charged per request and CPU time
- Batching helps reduce costs

### KV Costs
- Minimal for job tracking
- Consider cleanup of old job records

## Security Considerations

1. **CORS Configuration**: Currently set to allow all origins for development. Restrict in production.

2. **Rate Limiting**: Consider implementing rate limiting to prevent abuse.

3. **File Validation**: Validate file types and sizes both client and server-side.

4. **Presigned URL Expiration**: URLs expire after 1 hour by default.

## Next Steps (Future Phases)

### Phase 3: Real-time Updates
- Implement Server-Sent Events (SSE) for real-time job status
- Replace polling with push notifications

### Phase 4: Enhanced Security
- Add authentication/authorization
- Implement rate limiting
- Add CAPTCHA/Turnstile protection

### Phase 5: Advanced Features
- Telegram bot integration with async pipeline
- Multiple export formats (PDF, DOCX)
- Summary generation with AI

## Support

If you encounter issues:
1. Check the logs with `npx wrangler tail`
2. Verify all resources are created and configured correctly
3. Test each component individually
4. Review the Cloudflare Workers documentation for specific error codes