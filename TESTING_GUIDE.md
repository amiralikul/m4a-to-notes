# Testing Guide: Paddle + Clerk Integration

## 🔧 Prerequisites Setup

### 1. Backend (Cloudflare Worker) Setup
```bash
cd /Users/amir/projects/m4a-to-notes

# Set the shared secret (use a strong random string)
npx wrangler secret put INTERNAL_API_SECRET

# Deploy the worker
npx wrangler deploy

# Verify deployment
curl https://m4a-to-notes.productivity-tools.workers.dev/api/health
```

### 2. Frontend Environment Setup
```bash
cd /Users/amir/projects/m4a-to-notes-frontend

# Update .env with the SAME secret used above
# .env should contain:
INTERNAL_API_SECRET=your_actual_secret_here
```

### 3. Paddle Sandbox Setup
1. Go to [Paddle Sandbox Dashboard](https://sandbox-vendors.paddle.com/)
2. Create a product (e.g., "Pro Plan")
3. Create a price for the product (e.g., $19/month)
4. Copy the price ID (starts with `pri_`)
5. Update `/src/lib/pricing.js`:
```js
PRO: {
  name: "Lite",
  price: 19,
  priceId: 'pri_your_actual_price_id_here', // Replace with real ID
  // ...
}
```

## 🧪 Testing Scenarios

### Test 1: Basic Setup Verification

#### Start both applications:
```bash
# Terminal 1 - Worker (for local testing)
cd /Users/amir/projects/m4a-to-notes
npx wrangler dev --local

# Terminal 2 - Frontend
cd /Users/amir/projects/m4a-to-notes-frontend
npm run dev
```

#### Verify endpoints:
```bash
# Test Worker health
curl http://localhost:8787/api/health

# Test Next.js proxy
curl http://localhost:3000/api/health
```

### Test 2: Authentication & Entitlements Flow

1. **Visit the app**: http://localhost:3000
2. **Sign up/Sign in** with Clerk
3. **Check default entitlements**:
   - Open browser DevTools → Network tab
   - Look for a call to `/api/me/entitlements`
   - Should return: `{ "entitlements": { "plan": "free", "status": "none" } }`

### Test 3: Paddle Checkout Integration

1. **Navigate to checkout page** (or wherever PaddleCheckout is used)
2. **Click "Buy Now"** button
3. **Verify checkout opens** with Paddle overlay
4. **Check browser console** for:
   ```
   Opening checkout with options: {
     priceId: "pri_...",
     userEmail: "user@example.com",
     clerkUserId: "user_..."
   }
   ```

### Test 4: Complete Purchase Flow (Sandbox)

1. **Complete a test purchase**:
   - Use test card: `4242 4242 4242 4242`
   - Any future expiry date
   - CVC: `100`
   
2. **Monitor webhook processing**:
   ```bash
   # Watch Next.js logs
   npm run dev
   
   # Watch Worker logs (if deployed)
   npx wrangler tail
   ```

3. **Verify webhook received**:
   - Check Next.js console for: "Received Paddle webhook"
   - Check for: "Syncing entitlements to worker"
   - Look for successful sync log

### Test 5: Entitlements Update Verification

After successful purchase:

1. **Refresh the app**
2. **Check updated entitlements**:
   ```bash
   # Should now return plan: "pro", status: "active"
   curl -H "Cookie: your-session-cookie" http://localhost:3000/api/me/entitlements
   ```

3. **Verify in browser DevTools**:
   - Network tab → `/api/me/entitlements`
   - Response should show upgraded plan

### Test 6: Direct Worker API Testing

Test the internal Worker endpoints directly:

```bash
# Test entitlements sync (replace with actual user ID and secret)
curl -X POST http://localhost:8787/api/entitlements/sync \
  -H "Content-Type: application/json" \
  -H "X-Internal-Secret: your_secret_here" \
  -d '{
    "userId": "user_test123",
    "plan": "pro",
    "status": "active",
    "provider": "paddle",
    "meta": {
      "subscriptionId": "sub_test",
      "customerId": "cus_test"
    }
  }'

# Test entitlements retrieval
curl -H "X-Internal-Secret: your_secret_here" \
  http://localhost:8787/api/entitlements/user_test123
```

## 🐛 Debugging Common Issues

### Issue 1: Webhook Not Received
**Symptoms**: No webhook logs in Next.js console
**Solutions**:
1. Check Paddle webhook URL is set to your frontend domain
2. Ensure `/api/webhook` is accessible (not proxied to Worker)
3. Verify Paddle webhook is configured for your product

### Issue 2: "Configuration Error"
**Symptoms**: 500 error on entitlements API
**Solutions**:
1. Verify `INTERNAL_API_SECRET` is set in both Worker and Frontend
2. Check secrets match exactly (no extra spaces/characters)
3. Redeploy Worker after setting secrets

### Issue 3: "Sign In Required" on Checkout
**Symptoms**: Checkout button disabled
**Solutions**:
1. Ensure user is signed in to Clerk
2. Check `useUser()` hook is returning user data
3. Verify Clerk provider wraps the component

### Issue 4: Entitlements Not Updating
**Symptoms**: Plan stays "free" after purchase
**Solutions**:
1. Check webhook logs for errors
2. Verify `clerkUserId` is in Paddle `customData`
3. Test Worker sync endpoint directly
4. Check KV namespace is correctly configured

## 📊 Expected Log Patterns

### Successful Purchase Flow:
```
[Next.js] Received Paddle webhook: subscription.created
[Next.js] Syncing entitlements to worker: { userId: "user_...", plan: "pro", status: "active" }
[Worker] Entitlements synced successfully
[Next.js] Entitlements fetched successfully: { plan: "pro", status: "active" }
```

### Webhook Processing:
```
[Next.js] Opening checkout with options: { clerkUserId: "user_..." }
[Paddle] subscription.created event
[Next.js] Mapping subscription pri_... to plan: pro
[Worker] Updated user entitlements: { plan: "pro", status: "active" }
```

## 🔍 Manual Testing Checklist

- [ ] Worker deploys successfully
- [ ] Frontend starts without errors
- [ ] Health endpoints respond correctly
- [ ] User can sign in with Clerk
- [ ] Default entitlements return "free" plan
- [ ] Checkout button shows for authenticated users
- [ ] Paddle checkout opens with correct options
- [ ] Test purchase completes successfully
- [ ] Webhook is received and processed
- [ ] Entitlements update to "pro" after purchase
- [ ] UI reflects new plan after refresh

## 🚀 Production Deployment

Before going live:

1. **Update environment URLs**:
   - Set production Worker URL in `next.config.mjs`
   - Configure production Paddle webhooks
   
2. **Enable webhook signature verification**:
   ```js
   // Uncomment in webhook/route.js
   if (!verifyWebhookSignature(body, signature, webhookSecret)) {
     return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
   }
   ```

3. **Set production secrets**:
   ```bash
   npx wrangler secret put INTERNAL_API_SECRET --env production
   ```

4. **Test end-to-end** in production environment