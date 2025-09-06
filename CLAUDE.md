# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.


---
description: Ensure what you implement Always Works™ with comprehensive testing
---

# How to ensure Always Works™ implementation

Please ensure your implementation Always Works™ for: $ARGUMENTS.

Follow this systematic approach:

## Core Philosophy

- "Should work" ≠ "does work" - Pattern matching isn't enough
- I'm not paid to write code, I'm paid to solve problems
- Untested code is just a guess, not a solution

# The 30-Second Reality Check - Must answer YES to ALL:

- Did I run/build the code?
- Did I trigger the exact feature I changed?
- Did I see the expected result with my own observation (including GUI)?
- Did I check for error messages?
- Would I bet $100 this works?

# Phrases to Avoid:

- "This should work now"
- "I've fixed the issue" (especially 2nd+ time)
- "Try it now" (without trying it myself)
- "The logic is correct so..."

# Specific Test Requirements:

- UI Changes: Actually click the button/link/form
- API Changes: Make the actual API call
- Data Changes: Query the database
- Logic Changes: Run the specific scenario
- Config Changes: Restart and verify it loads

# The Embarrassment Test:

"If the user records trying this and it fails, will I feel embarrassed to see his face?"

# Time Reality:

- Time saved skipping tests: 30 seconds
- Time wasted when it doesn't work: 30 minutes
- User trust lost: Immeasurable

A user describing a bug for the third time isn't thinking "this AI is trying hard" - they're thinking "why am I wasting time with this incompetent tool?"







## Project Overview

This is a dual-application project for M4A audio transcription:

1. **Backend (m4a-to-notes)**: Telegram bot deployed on Cloudflare Workers that transcribes M4A files using OpenAI Whisper API
2. **Frontend (m4a-to-notes-frontend)**: Next.js web application for direct file upload and transcription

## Architecture

### Backend: Telegram Bot (Cloudflare Workers)
- **Framework**: Cloudflare Workers with custom Telegram webhook handler
- **Main entry**: `src/index.js` - Contains the complete bot logic and Worker fetch handler
- **Transcription**: OpenAI Whisper API integration
- **File handling**: In-memory processing, no persistent storage
- **Deployment**: Cloudflare Workers (`npx wrangler deploy`)

### Frontend: Web Application (Next.js)
- **Framework**: Next.js 15.4.5 with App Router
- **UI Library**: Tailwind CSS with Radix UI components
- **Main page**: `src/app/page.jsx` - Landing page with file upload interface
- **Components**: Located in `src/components/` with ui/ subdirectory for reusable components

## Common Development Commands

### Backend (Cloudflare Workers)
```bash
# Development server (local testing)
npx wrangler dev --local

# Deploy to Cloudflare Workers
npx wrangler deploy

# View logs
npx wrangler tail

# Set production secrets
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OPENAI_API_KEY
```

### Frontend (Next.js)
```bash
# Development server
npm run dev

# Build for production
npm run build

# Start production server
npm run start

# Lint code
npm run lint
```

## Key Configuration Files

- **Backend**: `wrangler.toml` - Cloudflare Workers configuration with environment variables
- **Frontend**: `next.config.mjs`, `tailwind.config.js`, `components.json` - Next.js and UI configuration

## Core Components

### Backend Components
- `TelegramBot` class in `src/index.js` - Handles all Telegram API interactions
- `transcribeAudio()` function - OpenAI Whisper API integration
- `handleTelegramUpdate()` - Main webhook handler for processing updates
- `Logger` class in `src/logger.js` - Structured logging utility

### Frontend Components
- `FileUpload` component - Drag & drop interface for M4A files
- UI components in `src/components/ui/` - Reusable Radix UI components
- Layout and styling in `src/app/layout.js` and `src/app/globals.css`

## Environment Variables

### Backend (Cloudflare Workers)
- `TELEGRAM_BOT_TOKEN` - Required: Bot token from @BotFather
- `OPENAI_API_KEY` - Required: OpenAI API key for Whisper
- `LOG_LEVEL` - Optional: ERROR, WARN, INFO, DEBUG (defaults to INFO)
- `NODE_ENV` - Optional: Environment indicator

### Development Workflow

1. **Local Development**: Use `npx wrangler dev --local` to test bot locally
2. **Webhook Testing**: Use Cloudflare Tunnel with `cloudflared tunnel --url http://localhost:8787`
3. **File Processing**: Bot supports M4A files up to 25MB (Whisper API limit)
4. **Message Handling**: Automatically splits long transcriptions into multiple messages

## Testing Strategy

- **Manual testing**: Use various M4A file formats and sizes
- **Error scenarios**: File size limits, invalid formats, API failures
- **Telegram commands**: `/start` and `/help` commands
- **Performance**: Monitor transcription time and file download speed

## Deployment Notes

- **Backend**: Deploy to Cloudflare Workers with environment secrets
- **Frontend**: Can be deployed to Vercel or other Next.js-compatible platforms
- **Webhook setup**: Configure Telegram webhook URL after deployment
- **Monitoring**: Use `npx wrangler tail` for real-time log monitoring