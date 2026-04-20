/**
 * AI Solo Checkout Worker
 * ========================
 * Cloudflare Worker handling:
 *   GET  /kaufen?company=X&campaign=Y  → Stripe Checkout Session → redirect
 *   POST /webhook/stripe               → payment confirmation → delivery
 *   GET  /download/{token}             → PDF download from R2
 *
 * Environment bindings:
 *   REPORTS    — R2 bucket (aisolo-reports)
 *   TOKENS     — KV namespace (download tokens)
 *   STRIPE_SECRET_KEY      — secret
 *   STRIPE_WEBHOOK_SECRET  — secret
 *   STRIPE_PRICE_ID        — var
 *   SITE_URL               — var
 *   SENDER_EMAIL           — var
 *   SENDER_NAME            — var
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // Route: /kaufen → create Stripe Checkout Session
      if (url.pathname === "/kaufen" && request.method === "GET") {
        return handleKaufen(url, env);
      }

      // Route: /webhook/stripe → Stripe webhook
      if (url.pathname === "/webhook/stripe" && request.method === "POST") {
        return handleWebhook(request, env);
      }

      // Route: /download/{token} → serve PDF
      if (url.pathname.startsWith("/download/") && request.method === "GET") {
        const token = url.pathname.replace("/download/", "");
        return handleDownload(token, env);
      }

      // Route: /lookup?session_id=... → return download URL for a completed session
      if (url.pathname === "/lookup" && request.method === "GET") {
        return handleLookup(url, env);
      }

      // Route: /api/teaser-request → inbound teaser request from website form
      if (url.pathname === "/api/teaser-request" && request.method === "POST") {
        return handleTeaserRequest(request, env);
      }

      // Route: /api/fan-signup → launch-notification subscriber from website
      if (url.pathname === "/api/fan-signup" && request.method === "POST") {
        return handleFanSignup(request, env);
      }

      // Route: /health → health check
      if (url.pathname === "/health") {
        return jsonResponse({ status: "ok", service: "aisolo-checkout" });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },
};

// ── /kaufen — Create Stripe Checkout Session ────────────────────────────

async function handleKaufen(url, env) {
  const customerId = url.searchParams.get("company");
  const campaign = url.searchParams.get("campaign");

  if (!customerId || !campaign) {
    return htmlResponse(errorPage(
      "Fehlende Parameter",
      "Der Kauflink ist unvollständig. Bitte verwenden Sie den Link aus Ihrer E-Mail."
    ), 400);
  }

  // Locate report in R2 by Customer ID prefix.
  // Files are named: full_reports/{campaign}/Google_Reviews_{customerId}_{slug}_Analyse.pdf
  const prefix = `full_reports/${campaign}/Google_Reviews_${customerId}_`;
  const listing = await env.REPORTS.list({ prefix, limit: 1 });
  const reportKey = listing.objects?.[0]?.key;

  if (!reportKey) {
    return htmlResponse(errorPage(
      "Bericht nicht gefunden",
      "Der angeforderte Bericht ist nicht verfügbar. Bitte kontaktieren Sie uns unter hello@aisolo.io."
    ), 404);
  }

  // Create Stripe Checkout Session via API
  const session = await stripePost("/v1/checkout/sessions", {
    "mode": "payment",
    "line_items[0][price]": env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "link",
    "metadata[company_id]": customerId,
    "metadata[campaign]": campaign,
    "metadata[report_key]": reportKey,
    "client_reference_id": customerId,
    "success_url": `${env.SITE_URL}/danke.html?session_id={CHECKOUT_SESSION_ID}`,
    "cancel_url": env.SITE_URL,
    "locale": "de",
    "consent_collection[terms_of_service]": "required",
    "custom_text[terms_of_service_acceptance][message]":
      "Mit Bereitstellung des Downloads erlischt mein Widerrufsrecht " +
      "([Widerrufsbelehrung](https://www.aisolo.io/widerruf.html)).",
  }, env.STRIPE_SECRET_KEY);

  if (session.error) {
    console.error("Stripe error:", JSON.stringify(session.error));
    return htmlResponse(errorPage(
      "Fehler bei der Zahlungsabwicklung",
      "Bitte versuchen Sie es erneut oder kontaktieren Sie uns unter hello@aisolo.io."
    ), 500);
  }

  // Redirect to Stripe Checkout
  return Response.redirect(session.url, 303);
}

// ── /webhook/stripe — Handle payment confirmation ───────────────────────

async function handleWebhook(request, env) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  // Verify webhook signature
  const event = await verifyStripeWebhook(body, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!event) {
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const companyId = session.metadata?.company_id;
    const campaign = session.metadata?.campaign;
    const reportKey = session.metadata?.report_key;
    const customerEmail = session.customer_details?.email;

    if (!reportKey || !customerEmail) {
      console.error("Missing metadata or email in webhook:", JSON.stringify(session));
      return jsonResponse({ received: true, warning: "missing data" });
    }

    // Generate download token
    const token = crypto.randomUUID();
    const tokenData = {
      reportKey,
      companyId,
      campaign,
      customerEmail,
      downloadsRemaining: 3,
      createdAt: new Date().toISOString(),
      stripeSessionId: session.id,
    };

    // Store token in KV with 72h TTL + a session_id → token lookup key
    // so the danke.html page can fetch the download URL via /lookup.
    await env.TOKENS.put(token, JSON.stringify(tokenData), {
      expirationTtl: 72 * 60 * 60,
    });
    await env.TOKENS.put(`session:${session.id}`, token, {
      expirationTtl: 72 * 60 * 60,
    });

    const downloadUrl = `${env.WORKER_URL}/download/${token}`;

    console.log(`SALE: ${companyId} | ${customerEmail} | ${session.amount_total / 100} EUR | token: ${token}`);
    console.log(`DOWNLOAD_LINK: ${downloadUrl}`);

    const emailResult = await sendDownloadEmail(customerEmail, downloadUrl, env);
    if (!emailResult.ok) {
      console.error(`Email send failed for ${customerEmail}: ${emailResult.error}`);
    } else {
      console.log(`Email sent to ${customerEmail} (id: ${emailResult.id})`);
    }
  }

  return jsonResponse({ received: true });
}

// ── /lookup — Return download URL for a completed Stripe session ────────

async function handleLookup(url, env) {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return jsonResponse({ error: "invalid session_id" }, 400);
  }

  const token = await env.TOKENS.get(`session:${sessionId}`);
  if (!token) {
    // Webhook hasn't fired yet — client should keep polling.
    return jsonResponse({ status: "pending" }, 202);
  }

  return jsonResponse({
    status: "ready",
    downloadUrl: `${env.WORKER_URL}/download/${token}`,
  });
}

// ── Email delivery via Resend ───────────────────────────────────────────

async function sendDownloadEmail(toEmail, downloadUrl, env) {
  if (!env.RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const subject = "Ihre Google Reviews Analyse ist bereit – Download-Link";
  const html = buildDownloadEmailHtml(downloadUrl);
  const text = buildDownloadEmailText(downloadUrl);

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SENDER_NAME} <${env.SENDER_EMAIL}>`,
      to: [toEmail],
      reply_to: env.SENDER_EMAIL,
      subject,
      html,
      text,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    return { ok: false, error: JSON.stringify(data) };
  }
  return { ok: true, id: data.id };
}

function buildDownloadEmailHtml(downloadUrl) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ihre Google Reviews Analyse ist bereit</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:'Helvetica Neue',Arial,sans-serif;color:#132f35;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
<tr><td style="background:#1a4f55;padding:32px 40px;color:#ffffff;">
<div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85;">AI Solo</div>
<div style="font-size:22px;font-weight:600;margin-top:8px;">Ihre Analyse ist bereit</div>
</td></tr>
<tr><td style="padding:40px;">
<p style="font-size:16px;line-height:1.6;margin:0 0 16px;">Guten Tag,</p>
<p style="font-size:16px;line-height:1.6;margin:0 0 16px;">vielen Dank f&uuml;r Ihre Bestellung. Ihre individuelle Google-Reviews-Analyse mit Aktionsplan steht jetzt zum Download bereit.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:32px 0;"><tr>
<td style="border-radius:8px;background:#1a4f55;">
<a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">Bericht herunterladen &rarr;</a>
</td></tr></table>
<p style="font-size:14px;line-height:1.6;color:#6b7280;margin:0 0 8px;"><strong>Wichtig:</strong> Der Download-Link ist 72 Stunden g&uuml;ltig und kann bis zu 3-mal verwendet werden.</p>
<p style="font-size:14px;line-height:1.6;color:#6b7280;margin:0 0 24px;">Falls der Button nicht funktioniert, kopieren Sie folgenden Link in Ihren Browser:<br>
<a href="${downloadUrl}" style="color:#1a4f55;word-break:break-all;">${downloadUrl}</a></p>
<p style="font-size:15px;line-height:1.6;margin:24px 0 0;">Bei Fragen antworten Sie einfach auf diese E-Mail.</p>
<p style="font-size:15px;line-height:1.6;margin:24px 0 0;">Mit freundlichen Gr&uuml;&szlig;en<br><strong>Uwe Vogt</strong><br>AI Solo</p>
</td></tr>
<tr><td style="background:#fafafa;padding:24px 40px;font-size:12px;color:#6b7280;text-align:center;">
AI Solo &middot; Dr. Uwe Vogt &middot; B&ouml;blingen, Deutschland<br>
<a href="https://www.aisolo.io/impressum.html" style="color:#6b7280;">Impressum</a> &middot;
<a href="https://www.aisolo.io/datenschutz.html" style="color:#6b7280;">Datenschutz</a> &middot;
<a href="https://www.aisolo.io/agb.html" style="color:#6b7280;">AGB</a>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildDownloadEmailText(downloadUrl) {
  return `Guten Tag,

vielen Dank für Ihre Bestellung. Ihre individuelle Google-Reviews-Analyse mit Aktionsplan steht jetzt zum Download bereit:

${downloadUrl}

Wichtig: Der Download-Link ist 72 Stunden gültig und kann bis zu 3-mal verwendet werden.

Bei Fragen antworten Sie einfach auf diese E-Mail.

Mit freundlichen Grüßen
Uwe Vogt
AI Solo

--
AI Solo · Dr. Uwe Vogt · Böblingen, Deutschland
Impressum: https://www.aisolo.io/impressum.html
Datenschutz: https://www.aisolo.io/datenschutz.html
AGB: https://www.aisolo.io/agb.html
`;
}

// ── /download/{token} — Serve PDF from R2 ───────────────────────────────

async function handleDownload(token, env) {
  if (!token || token.length < 10) {
    return htmlResponse(errorPage(
      "Ungültiger Link",
      "Dieser Download-Link ist ungültig. Bitte verwenden Sie den Link aus Ihrer Bestätigungs-E-Mail."
    ), 400);
  }

  // Look up token in KV
  const tokenDataStr = await env.TOKENS.get(token);
  if (!tokenDataStr) {
    return htmlResponse(errorPage(
      "Link abgelaufen",
      "Dieser Download-Link ist abgelaufen oder wurde bereits verwendet. " +
      "Download-Links sind 72 Stunden gültig. " +
      "Bitte kontaktieren Sie uns unter hello@aisolo.io für einen neuen Link."
    ), 410);
  }

  const tokenData = JSON.parse(tokenDataStr);

  if (tokenData.downloadsRemaining <= 0) {
    return htmlResponse(errorPage(
      "Download-Limit erreicht",
      "Sie haben die maximale Anzahl von 3 Downloads erreicht. " +
      "Bitte kontaktieren Sie uns unter hello@aisolo.io für einen neuen Link."
    ), 410);
  }

  // Fetch PDF from R2
  const obj = await env.REPORTS.get(tokenData.reportKey);
  if (!obj) {
    console.error(`Report not found in R2: ${tokenData.reportKey}`);
    return htmlResponse(errorPage(
      "Datei nicht gefunden",
      "Der Bericht konnte nicht geladen werden. Bitte kontaktieren Sie uns unter hello@aisolo.io."
    ), 404);
  }

  // Decrement download counter
  tokenData.downloadsRemaining -= 1;
  tokenData.lastDownloadAt = new Date().toISOString();
  const remainingTtl = Math.max(
    1,
    Math.floor((new Date(tokenData.createdAt).getTime() + 72 * 60 * 60 * 1000 - Date.now()) / 1000)
  );
  await env.TOKENS.put(token, JSON.stringify(tokenData), {
    expirationTtl: remainingTtl,
  });

  // Use the original filename from the R2 key, fallback to a generic one
  const filename = tokenData.reportKey?.split("/").pop()
    || `Google_Reviews_${tokenData.companyId || "bericht"}_Analyse.pdf`;

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Stripe helpers ──────────────────────────────────────────────────────

async function stripePost(path, params, secretKey) {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return resp.json();
}

async function verifyStripeWebhook(payload, sigHeader, secret) {
  // Stripe webhook signature verification using Web Crypto API
  if (!sigHeader || !secret) return null;

  const parts = {};
  for (const item of sigHeader.split(",")) {
    const [key, value] = item.split("=");
    parts[key.trim()] = value;
  }

  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return null;

  // Check timestamp freshness (5 min tolerance)
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (age > 300) return null;

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected !== signature) return null;

  return JSON.parse(payload);
}

// ── Response helpers ────────────────────────────────────────────────────

// ── /api/teaser-request — inbound teaser request from website form ──────
//
// Validates the payload, forwards it to the Apps Script webhook
// (env.SHEETS_WEBHOOK_URL) which writes a row to the CRM Sheet's
// `Inbound_Requests` tab. Optional Resend acknowledgment email to the
// requester. Local processor (`200_CRM/process_inbound.py`) picks it up
// from the sheet and runs Step 2 + Step 4 + SMTP delivery.
//
// Required env: SHEETS_WEBHOOK_URL  (secret — Apps Script /exec URL)
// Optional env: RESEND_API_KEY      (secret — for ack email)
async function handleTeaserRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const company  = String(body.company  || "").trim().slice(0, 120);
  const city     = String(body.city     || "").trim().slice(0, 80);
  const email    = String(body.email    || "").trim().slice(0, 120);
  const mapsUrl  = String(body.maps_url || "").trim().slice(0, 500);
  const consent  = body.consent === true;
  const source   = String(body.source   || "website").trim().slice(0, 60);

  if (!company || !city || !email || !consent) {
    return jsonResponse({ error: "Missing required fields" }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResponse({ error: "Invalid email" }, 400);
  }

  const payload = {
    timestamp: new Date().toISOString(),
    status: "new",
    company, city, email, maps_url: mapsUrl,
    consent: "Ja",
    source,
    user_agent: request.headers.get("User-Agent") || "",
    ip: request.headers.get("CF-Connecting-IP") || "",
  };

  // Forward to Apps Script (Inbound_Requests tab in CRM Sheet)
  if (env.SHEETS_WEBHOOK_URL) {
    try {
      await fetch(env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Sheets webhook failed:", err);
      // Continue — we still ack the user. Manual recovery via logs.
    }
  }

  // Send acknowledgment email via Resend (best-effort)
  if (env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${env.SENDER_NAME || "AI Solo"} <${env.SENDER_EMAIL || "hello@aisolo.io"}>`,
          to: [email],
          subject: "Ihre Vorschau-Anfrage bei AI Solo",
          text:
`Hallo,

vielen Dank für Ihre Anfrage.

Wir erstellen aktuell Ihre persönliche Vorschau für:
  Unternehmen: ${company}
  Ort: ${city}

Sie erhalten die Vorschau innerhalb von 24 Stunden an diese E-Mail-Adresse.

Bei Fragen einfach auf diese Mail antworten oder an hello@aisolo.io schreiben.

Beste Grüße
Ihr AI Solo Team
www.aisolo.io
`,
        }),
      });
    } catch (err) {
      console.error("Ack email failed:", err);
    }
  }

  return jsonResponse({ ok: true });
}

// ── /api/fan-signup — launch-notification subscriber ────────────────────
//
// Forwards { email, first_name?, interest_tags?, consent } to the same
// Apps Script webhook with action="fan_signup". The Apps Script handler
// dedupes by email, assigns a Customer ID, and writes a row to the
// `Fans` tab. Best-effort acknowledgment via Resend.
async function handleFanSignup(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const email     = String(body.email      || "").trim().slice(0, 120);
  const firstName = String(body.first_name || "").trim().slice(0, 60);
  const consent   = body.consent === true;
  const tags      = Array.isArray(body.interest_tags)
    ? body.interest_tags.map((t) => String(t).slice(0, 40)).slice(0, 6)
    : [];

  if (!email || !consent) {
    return jsonResponse({ error: "Missing email or consent" }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResponse({ error: "Invalid email" }, 400);
  }

  const payload = {
    action: "fan_signup",
    timestamp: new Date().toISOString(),
    email,
    first_name: firstName,
    interest_tags: tags,
    consent: true,
    source: String(body.source || "website-launch-signup").slice(0, 60),
    user_agent: request.headers.get("User-Agent") || "",
    ip: request.headers.get("CF-Connecting-IP") || "",
  };

  if (env.SHEETS_WEBHOOK_URL) {
    try {
      await fetch(env.SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Sheets webhook (fan_signup) failed:", err);
    }
  }

  if (env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${env.SENDER_NAME || "AI Solo"} <${env.SENDER_EMAIL || "hello@aisolo.io"}>`,
          to: [email],
          subject: "Willkommen bei AI Solo — Launch-Updates aktiviert",
          text:
`Hallo${firstName ? " " + firstName : ""},

danke für Ihr Interesse an AI Solo. Sie sind jetzt im Verteiler für Produkt-Launches.

Sie hören von uns, sobald wir ein neues Produkt veröffentlichen — kein Newsletter, keine Werbung dazwischen.

Bei Fragen einfach auf diese Mail antworten.

Beste Grüße
Ihr AI Solo Team
hello@aisolo.io · www.aisolo.io
`,
        }),
      });
    } catch (err) {
      console.error("Fan ack email failed:", err);
    }
  }

  return jsonResponse({ ok: true });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
  };
}

function errorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — AI Solo</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
body { font-family: 'Plus Jakarta Sans', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f4f4f7; margin: 0; }
.card { background: #fff; border-radius: 12px; padding: 48px; max-width: 480px; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
h1 { font-size: 24px; color: #132f35; margin-bottom: 16px; }
p { font-size: 15px; color: #404040; line-height: 1.7; }
a { color: #1a4f55; }
.back { display: inline-block; margin-top: 24px; color: #1a4f55; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="https://www.aisolo.io" class="back">&larr; Zurück zur Startseite</a>
</div>
</body>
</html>`;
}
