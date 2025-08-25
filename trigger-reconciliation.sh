#!/bin/bash

# Manual Paddle Reconciliation Trigger Script
# This script triggers manual reconciliation between Paddle and local entitlements

# Configuration
# TODO(human): Update these values with your actual deployment details
WORKER_URL="https://shopzilla-triumph-custody-kelly.trycloudflare.com"  # Update with your actual worker URL
INTERNAL_SECRET="internal_api_secret"  # Update with your INTERNAL_API_SECRET


# Options
HOURS=${1:-48}  # Hours to look back (default: 48)
DRY_RUN=${2:-false}  # Set to 'true' for dry run (default: false)

echo "🔄 Triggering manual reconciliation..."
echo "   Hours back: $HOURS"
echo "   Dry run: $DRY_RUN"
echo ""

# Make the API call
response=$(curl -s -w "\n%{http_code}" \
  -H "X-Internal-Secret: $INTERNAL_SECRET" \
  "$WORKER_URL/api/reconcile?hours=$HOURS&dry_run=$DRY_RUN")

# Parse response
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "200" ]; then
    echo "✅ Reconciliation completed successfully!"
    echo "$body" | jq '.' 2>/dev/null || echo "$body"
else
    echo "❌ Reconciliation failed (HTTP $http_code)"
    echo "$body"
fi