# Cloudflare Worker Setup — AI Solo Checkout

## Prerequisites
- Cloudflare account (free)
- Node.js installed
- Stripe account with product created

## Step 1: Install Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

## Step 2: Create R2 Bucket
```bash
wrangler r2 bucket create aisolo-reports
```

## Step 3: Create KV Namespace
```bash
wrangler kv namespace create TOKENS
```
Copy the `id` from the output and paste it into `wrangler.toml` replacing `PLACEHOLDER_KV_ID`.

## Step 4: Set Secrets
```bash
wrangler secret put STRIPE_SECRET_KEY
# paste your sk_live_... or sk_test_... key

wrangler secret put STRIPE_WEBHOOK_SECRET
# paste the whsec_... from Stripe Dashboard > Developers > Webhooks
```

## Step 5: Update wrangler.toml
- Set `STRIPE_PRICE_ID` to your actual price ID (price_...)
- Set the KV namespace `id`

## Step 6: Deploy
```bash
cd worker
wrangler deploy
```

## Step 7: Configure Custom Domain
In Cloudflare Dashboard > Workers > aisolo-checkout > Settings > Triggers:
- Add custom domain: `api.aisolo.io`
- Or add route: `api.aisolo.io/*`

At IONOS DNS, add:
```
Type: CNAME  Host: api  Value: aisolo-checkout.<your-account>.workers.dev.
```

## Step 8: Create Stripe Webhook
In Stripe Dashboard > Developers > Webhooks > Add endpoint:
- URL: `https://api.aisolo.io/webhook/stripe`
- Events: `checkout.session.completed`
- Copy the signing secret → set as `STRIPE_WEBHOOK_SECRET` (Step 4)

## Step 9: Test
1. Upload a test report to R2:
   ```bash
   wrangler r2 object put aisolo-reports/full_reports/test/test_company_full_report.pdf \
     --file path/to/test.pdf
   ```
2. Visit: `https://api.aisolo.io/kaufen?company=test_company&campaign=test`
3. Complete test payment in Stripe test mode
4. Check Worker logs: `wrangler tail`

## Architecture
```
Customer clicks CTA in email
  → GET api.aisolo.io/kaufen?company=X&campaign=Y
  → Worker creates Stripe Checkout Session
  → Redirect to Stripe hosted checkout
  → Customer pays
  → Stripe fires webhook to api.aisolo.io/webhook/stripe
  → Worker generates download token (72h TTL, 3 downloads)
  → Download link sent via email (Zapier/manual)
  → Customer clicks download link
  → GET api.aisolo.io/download/{token}
  → Worker serves PDF from R2
```
