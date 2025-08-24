# Paddle API Setup Guide

## Required Environment Variables

To enable Paddle subscription management, you need to set these secrets:

```bash
# Set your Paddle API key (get from Paddle Dashboard > Developer Tools > API Keys)
npx wrangler secret put PADDLE_API_KEY

# Set the environment (sandbox or production)
npx wrangler secret put PADDLE_ENVIRONMENT
```

## Getting Your Paddle API Key

1. **Log in to Paddle Dashboard**: https://vendors.paddle.com/ (production) or https://sandbox-vendors.paddle.com/ (sandbox)
2. **Navigate to Developer Tools > API Keys**
3. **Create a new API key** with these permissions:
   - `subscription:read`
   - `subscription:write` (required for cancellations)
   - `customer:read`
   - `customer:write` (required for customer portal)

## Environment Values

- **Sandbox**: `sandbox` (for testing)
- **Production**: `production` (for live subscriptions)

## Testing the Setup

After setting the secrets, test the configuration:

```bash
# Deploy with the new secrets
npx wrangler deploy

# Test subscription cancellation
curl -X POST https://your-worker.your-subdomain.workers.dev/api/paddle/cancel \
  -H "Content-Type: application/json" \
  -d '{"subscriptionId": "sub_test_id", "cancellationReason": "customer_request"}'
```

## Troubleshooting

- **403 Forbidden**: API key lacks required permissions
- **401 Unauthorized**: Invalid API key or wrong environment
- **404 Not Found**: Subscription doesn't exist in the specified environment

## Current Status
❌ PADDLE_API_KEY - Not set
❌ PADDLE_ENVIRONMENT - Not set