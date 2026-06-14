# AI Google Business Profile Audit (Lead Magnet)

A small web app:
- `index.html` — lead capture form + Google Maps link input, then shows the live AI audit results + your service offers ($37 call / $400/mo management).
- `api/audit.js` — serverless function that:
  1. Resolves the pasted Google Maps link
  2. Looks up the business on **Google Places API (New)** for real data (rating, review count, recent reviews, photo count, hours, categories, accessibility/parking/payment attributes)
  3. Fetches the business website and checks for schema markup, FAQ schema, title/meta tags (GEO/AI-readiness signals)
  4. Sends all of that to **Claude** to generate a real, personalized audit + score

## 1. Get an Anthropic API key (you said you need this)

1. Go to https://console.anthropic.com and sign in / create an account.
2. In the left sidebar, click **API Keys**.
3. Click **Create Key**, give it a name (e.g. "gbp-audit-tool"), and copy the key (starts with `sk-ant-...`). You won't be able to see it again, so save it somewhere safe.
4. Add billing under **Settings → Billing** — Claude API calls are pay-as-you-go (this app uses `claude-sonnet-4-6`; each audit costs roughly a fraction of a cent to a couple cents).

## 2. Deploy to Vercel

1. Push this folder to a GitHub repo (or use `vercel` CLI directly from this folder).
2. Go to https://vercel.com → **Add New Project** → import the repo (or run `npx vercel` from this directory).
3. In **Project Settings → Environment Variables**, add:
   - `GOOGLE_PLACES_API_KEY` — your existing Google Places API key
   - `ANTHROPIC_API_KEY` — the key from step 1
   - `LEAD_WEBHOOK_URL` — (optional) a Zapier/Make/Sheets webhook to log leads
4. Deploy. Vercel will serve `index.html` at the root and `api/audit.js` at `/api/audit` automatically — no extra config needed.

## 3. Before going live

- Make sure your Google Cloud project has **Places API (New)** enabled and billing set up. The `reviews` and `photos` fields are part of the "Atmosphere" SKU, which has a small per-request cost — set a budget alert in Google Cloud to be safe.
- Update `CALL_BOOKING_URL` and `MANAGEMENT_URL` near the top of the `<script>` in `index.html` to point at your real booking link (Calendly, Stripe checkout, etc.) instead of `mailto:`.
- Test with your own business's Google Maps link first.

## Local testing

```bash
npm i -g vercel
vercel dev
```

Then open the local URL it gives you (e.g. http://localhost:3000).
