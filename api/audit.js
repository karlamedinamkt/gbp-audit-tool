// Vercel serverless function: POST /api/audit
// Body: { name, email, business, phone, mapsUrl }
// 1. Resolves the Google Maps link the user pasted
// 2. Looks up the place on Google Places API (New)
// 3. Checks the business website for basic SEO / AI (GEO) signals
// 4. Sends everything to Claude to generate a real, personalized audit

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LEAD_WEBHOOK_URL = process.env.LEAD_WEBHOOK_URL || "";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name, email, business, phone, mapsUrl } = req.body || {};

    if (!name || !email || !business || !mapsUrl) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    if (!GOOGLE_API_KEY || !ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error:
          "Server is missing API keys. Set GOOGLE_PLACES_API_KEY and ANTHROPIC_API_KEY as environment variables.",
      });
    }

    // Fire-and-forget lead capture
    if (LEAD_WEBHOOK_URL) {
      fetch(LEAD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          business,
          phone,
          mapsUrl,
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {});
    }

    // 1. Resolve short links (maps.app.goo.gl, goo.gl/maps) to a full URL
    let resolvedUrl = mapsUrl;
    try {
      const resolved = await fetch(mapsUrl, { redirect: "follow" });
      resolvedUrl = resolved.url || mapsUrl;
    } catch {
      // fall back to the original URL
    }

    // 2. Pull a business-name hint and coordinates out of the URL
    const nameMatch = decodeURIComponent(resolvedUrl).match(/\/maps\/place\/([^/@]+)/);
    const coordMatch = resolvedUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const nameHint = nameMatch ? nameMatch[1].replace(/\+/g, " ") : business;
    const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
    const lng = coordMatch ? parseFloat(coordMatch[2]) : null;

    // 3. Text Search to find the place_id
    const searchBody = {
      textQuery: nameHint,
      ...(lat !== null && lng !== null
        ? {
            locationBias: {
              circle: {
                center: { latitude: lat, longitude: lng },
                radius: 500.0,
              },
            },
          }
        : {}),
    };

    const searchResp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_API_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
      },
      body: JSON.stringify(searchBody),
    });
    const searchData = await searchResp.json();
    const place = searchData?.places?.[0];

    if (!place) {
      return res.status(404).json({
        error:
          "We couldn't find that business on Google. Double-check the Maps link and try again.",
        debug: { nameHint, lat, lng, searchData },
      });
    }

    // 4. Place Details — the real audit data
    const fieldMask = [
      "id",
      "displayName",
      "formattedAddress",
      "nationalPhoneNumber",
      "internationalPhoneNumber",
      "websiteUri",
      "rating",
      "userRatingCount",
      "reviews",
      "photos",
      "regularOpeningHours",
      "currentOpeningHours",
      "businessStatus",
      "editorialSummary",
      "types",
      "primaryType",
      "primaryTypeDisplayName",
      "accessibilityOptions",
      "parkingOptions",
      "paymentOptions",
      "priceLevel",
    ].join(",");

    const detailsResp = await fetch(`https://places.googleapis.com/v1/places/${place.id}`, {
      headers: {
        "X-Goog-Api-Key": GOOGLE_API_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
    });
    const details = await detailsResp.json();

    // 5. Check the business website for SEO / GEO (AI search) signals
    let websiteSignals = null;
    if (details.websiteUri) {
      try {
        const siteResp = await fetch(details.websiteUri, {
          redirect: "follow",
          signal: AbortSignal.timeout(8000),
        });
        const html = await siteResp.text();
        websiteSignals = {
          hasTitle: /<title>([^<]{3,})<\/title>/i.test(html),
          hasMetaDescription: /<meta[^>]+name=["']description["'][^>]*>/i.test(html),
          hasSchemaJsonLd: /<script[^>]+type=["']application\/ld\+json["']/i.test(html),
          hasFaqSchema: /"@type"\s*:\s*"FAQPage"/i.test(html) || /FAQPage/i.test(html),
          hasLocalBusinessSchema: /"@type"\s*:\s*"(LocalBusiness|[A-Za-z]*Business|Restaurant|Store)"/i.test(html),
          hasH1: /<h1[\s>]/i.test(html),
        };
      } catch {
        websiteSignals = { error: "Website did not respond or could not be fetched." };
      }
    }

    // 6. Build the structured data set for Claude
    const auditInput = {
      business: {
        name: details.displayName?.text || business,
        address: details.formattedAddress,
        phone: details.nationalPhoneNumber || details.internationalPhoneNumber || null,
        website: details.websiteUri || null,
        businessStatus: details.businessStatus,
        primaryType: details.primaryTypeDisplayName?.text || details.primaryType,
        allTypes: details.types || [],
        priceLevel: details.priceLevel || null,
      },
      profileCompleteness: {
        hasEditorialSummary: !!details.editorialSummary?.text,
        editorialSummary: details.editorialSummary?.text || null,
        photoCount: details.photos?.length || 0,
        hasRegularHours: !!details.regularOpeningHours,
        hasCurrentHours: !!details.currentOpeningHours,
        accessibilityOptions: details.accessibilityOptions || null,
        parkingOptions: details.parkingOptions || null,
        paymentOptions: details.paymentOptions || null,
      },
      reviews: {
        rating: details.rating || null,
        totalReviews: details.userRatingCount || 0,
        recent: (details.reviews || []).slice(0, 5).map((r) => ({
          rating: r.rating,
          text: r.text?.text || "",
          publishTime: r.publishTime,
        })),
      },
      website: websiteSignals,
    };

    // 7. Ask Claude to generate the actual audit
    const prompt = buildAuditPrompt(auditInput, name, business);

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) {
      return res.status(502).json({ error: "AI analysis failed.", details: claudeData });
    }

    const rawText = claudeData.content?.[0]?.text || "{}";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const report = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);

    return res.status(200).json({
      lead: { name, email, business, phone },
      placeData: auditInput,
      report,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong running the audit.", details: String(err) });
  }
}

function buildAuditPrompt(data, leadName, businessName) {
  return `You are a local SEO / Google Business Profile auditor. You've pulled REAL data below for "${businessName}" from Google Places and their website. Generate an honest, specific audit based ONLY on this data. Do not invent facts you can't see in the data.

DATA:
${JSON.stringify(data, null, 2)}

Some important things to know:
- The public API does NOT expose the owner-written business description, Google Posts history, messaging settings, or Q&A — be honest that these need a manual/live check, don't claim to know them.
- Score the profile 0-100 based on what you CAN verify: profile completeness, categories/type accuracy, photo count, review volume/rating/recency, hours setup, attributes (accessibility/parking/payment options), and website GEO/SEO signals (schema markup, FAQ schema, title/meta, H1).
- Findings should reference the ACTUAL data (e.g. "You have 142 reviews at 4.6 stars" or "Only 3 photos on your profile" or "No schema markup found on your website").
- Where something can't be checked from public data (description quality, posts, messaging, Q&A), add a finding with status "unknown" and note it should be checked live.

Respond with ONLY valid JSON, no markdown, matching this exact shape:
{
  "score": <integer 0-100>,
  "verdict": "<one of: critical, needs_work, good, excellent>",
  "verdictTitle": "<short headline, 6-10 words>",
  "verdictText": "<2-3 sentences, personalized using the business name and real numbers from the data>",
  "findings": [
    {
      "title": "<short finding title>",
      "status": "<good | warn | bad | unknown>",
      "detail": "<1-2 sentences referencing the real data, explaining why it matters>"
    }
    // 6-9 findings covering: categories/business type, photos, reviews (rating+volume+recency), hours, attributes/accessibility, website SEO schema, GEO/AI readiness, and at least one "unknown" item (description/posts/messaging/Q&A — needs live check)
  ]
}`;
}
