/**
 * Serverless Function: Claude-Powered Website Audit (Standalone)
 *
 * Flow:
 *   1. Receives { contactId?, firstName, lastName?, email, phone?, website } via POST
 *   2. If no contactId, creates a CRM contact using GHL_API_KEY
 *   3. Fetches the website's HTML (GET request through CORS proxy)
 *   4. Calls Google PageSpeed Insights API (free, no key needed)
 *   5. Sends HTML + PageSpeed data to Claude (Anthropic API) with ANTHROPIC_API_KEY
 *   6. Takes Claude's response and POSTs it to the CRM as a note on the contact
 *      using contactId and GHL_API_KEY
 *   7. Applies the "audit-complete" tag to the CRM contact
 *   8. Returns 200 success
 *
 * === ENVIRONMENT VARIABLES (set on Vercel) ===
 *   ANTHROPIC_API_KEY = sk-ant-...  (from https://console.anthropic.com)
 *   GHL_API_KEY       = pit-...     (from your CRM: Settings → API → API Key)
 */

export const config = { runtime: 'edge' };

// ─── Types ───────────────────────────────────────────────────────────
interface AuditRequest {
  contactId?: string;
  firstName: string;
  lastName?: string;
  email: string;
  phone?: string;
  website: string;
}

// ─── Helper: fetch with timeout ──────────────────────────────────────
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ─── Step 1: Fetch page HTML through CORS proxy ──────────────────────
async function fetchPageHtml(target: string): Promise<string | null> {
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
    `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(target)}`,
  ];
  for (const proxy of proxies) {
    try {
      const res = await fetchWithTimeout(proxy, {}, 10000);
      const html = await res.text();
      if (html && html.length > 200) return html;
    } catch { /* try next */ }
  }
  return null;
}

// ─── Step 2: Fetch Google PageSpeed Insights data (free, no key) ─────
async function fetchPageSpeedData(target: string): Promise<any | null> {
  const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(target)}&strategy=mobile&category=PERFORMANCE&category=SEO&category=BEST_PRACTICES&category=ACCESSIBILITY`;
  try {
    const res = await fetchWithTimeout(psiUrl, {}, 25000);
    const data = await res.json();
    if (data?.lighthouseResult && !data?.error) return data.lighthouseResult;
  } catch { /* PSI failed */ }
  return null;
}

// ─── Step 3: Build the Claude system prompt ───────────────────────────
const AUDIT_SYSTEM_PROMPT = `You are a senior SEO and web performance consultant performing a professional website audit for a potential client. You will receive Google PageSpeed Insights data and the page HTML. Analyze them and provide a comprehensive, actionable audit report.

Your report must be well-structured, professional, and easy for a non-technical business owner to understand. Include:

1. Executive Summary — 2-3 sentences on the site's overall health and biggest opportunities.
2. Performance Scores — speed, SEO, best practices, and accessibility scores (0-100).
3. Key Issues — 5-10 specific issues ordered by severity (high/medium/low), each with a clear label and explanation of what's wrong and why it matters.
4. Recommendations — 5-8 concrete, actionable recommendations the business owner can act on.
5. Conversion Opportunities — identify areas where the site could better capture leads, book appointments, or convert visitors.

Rules:
- Base scores on the actual PageSpeed data when available. If unavailable, derive scores from the HTML analysis.
- Be honest and specific — do not sugarcoat problems.
- Write in clear, professional language a business owner would understand.
- Format as clean markdown with headers and bullet points.`;

// ─── Step 4: Call Claude API ─────────────────────────────────────────
async function callClaude(target: string, pageSpeed: any | null, html: string | null): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');

  const lhScores = pageSpeed
    ? `Google PageSpeed Insights Scores:
   - Performance: ${Math.round((pageSpeed.categories?.performance?.score ?? 0) * 100)}/100
   - SEO: ${Math.round((pageSpeed.categories?.seo?.score ?? 0) * 100)}/100
   - Best Practices: ${Math.round((pageSpeed.categories?.['best-practices']?.score ?? 0) * 100)}/100
   - Accessibility: ${Math.round((pageSpeed.categories?.accessibility?.score ?? 0) * 100)}/100

Key PageSpeed Audits:
${Object.entries(pageSpeed.audits || {})
  .filter(([, a]: any) => a.score !== null && a.score < 0.9 && a.title)
  .slice(0, 15)
  .map(([key, a]: any) => `   - ${a.title}: score ${Math.round((a.score ?? 0) * 100)}/100${a.numericValue ? ` (${a.displayValue || a.numericValue})` : ''}`)
  .join('\n')}`
    : 'Google PageSpeed Insights data was unavailable for this URL.';

  const htmlSnippet = html
    ? `Page HTML (truncated to first 8000 chars for analysis):
\`\`\`html
${html.slice(0, 8000)}
\`\`\``
    : 'Page HTML was unavailable for this URL. Analyze based on PageSpeed data only.';

  const userMessage = `Please perform a comprehensive website audit for: ${target}

${lhScores}

${htmlSnippet}

Provide your full audit report now.`;

  const response = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: AUDIT_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userMessage }
        ],
      }),
    },
    30000
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error('Empty response from Claude');
  return text;
}

// ─── Step 5: POST Claude's audit as a note on the CRM contact ────────
const CRM_API_BASE = 'https://services.leadconnectorhq.com';

async function addNoteToContact(contactId: string, auditReport: string, firstName: string, website: string): Promise<void> {
  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) throw new Error('GHL_API_KEY environment variable is not set');

  const noteBody = `📋 AI Website Audit Report — ${website}

${auditReport}

---
This audit was generated automatically by Framework Digital's AI audit system for ${firstName}.`;

  const response = await fetchWithTimeout(
    `${CRM_API_BASE}/contacts/${contactId}/notes`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        body: noteBody,
      }),
    },
    15000
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`CRM note creation failed ${response.status}: ${errText}`);
  }
}

// ─── Step 6: Apply the "audit-complete" tag to the CRM contact ───────
async function addTagToContact(contactId: string, tag: string): Promise<void> {
  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) throw new Error('GHL_API_KEY environment variable is not set');

  const response = await fetchWithTimeout(
    `${CRM_API_BASE}/contacts/${contactId}/tags`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        tags: [tag],
      }),
    },
    15000
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`CRM tag application failed ${response.status}: ${errText}`);
  }
}

// ─── Step 7: Create a CRM contact (if no contactId provided) ─────────
async function createCRMContact(data: { firstName: string; lastName?: string; email: string; phone?: string; website: string }): Promise<string> {
  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) throw new Error('GHL_API_KEY environment variable is not set');

  const response = await fetchWithTimeout(
    `${CRM_API_BASE}/contacts/`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        firstName: data.firstName,
        lastName: data.lastName || '',
        email: data.email,
        phone: data.phone || '',
        website: data.website,
      }),
    },
    15000
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`CRM contact creation failed ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const contactId = result?.contact?.id || result?.id;
  if (!contactId) throw new Error('CRM contact creation succeeded but no contactId was returned');
  return contactId;
}

// ─── Main handler (Vercel Edge Function) ──────────────────────────────
export default async function handler(req: Request): Promise<Response> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    const rawText = await req.text();
    let body: AuditRequest;
    try {
      body = JSON.parse(rawText);
    } catch {
      return new Response(JSON.stringify({ success: false, error: 'Invalid JSON body' }), { status: 400, headers });
    }

    const { contactId: passedContactId, firstName, lastName, email, phone, website } = body;

    if (!website || !email) {
      return new Response(JSON.stringify({
        success: false,
        error: 'email and website are required',
      }), { status: 400, headers });
    }

    // Create a CRM contact if no contactId was provided, otherwise use the passed one
    let contactId = passedContactId;
    if (!contactId) {
      console.log(`[Audit] No contactId provided — creating CRM contact for ${firstName} (${email})...`);
      contactId = await createCRMContact({ firstName, lastName, email, phone, website });
      console.log(`[Audit] CRM contact created: ${contactId}`);
    }

    console.log(`[Audit] Starting audit for ${firstName} (${email}) — website: ${website}`);

    // Normalize URL
    let target = website.trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

    // Fetch HTML and PageSpeed data in parallel
    const [html, pageSpeed] = await Promise.all([
      fetchPageHtml(target),
      fetchPageSpeedData(target),
    ]);

    if (!html && !pageSpeed) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unable to retrieve any data for this URL. Please check the URL and try again.',
      }), { status: 502, headers });
    }

    // Call Claude with the data
    console.log('[Audit] Calling Claude API...');
    const auditReport = await callClaude(target, pageSpeed, html);
    console.log('[Audit] Claude response received, length:', auditReport.length);

    // POST the audit as a note on the CRM contact
    console.log(`[Audit] Posting audit note to CRM contact ${contactId}...`);
    await addNoteToContact(contactId, auditReport, firstName, target);
    console.log('[Audit] Note posted to CRM successfully.');

    // Apply the "audit-complete" tag to the contact
    console.log(`[Audit] Applying "audit-complete" tag to contact ${contactId}...`);
    await addTagToContact(contactId, 'audit-complete');
    console.log('[Audit] Tag applied successfully.');

    return new Response(JSON.stringify({
      success: true,
      message: 'Audit completed and note added to contact.',
      contactId,
      website: target,
    }), { status: 200, headers });

  } catch (error: any) {
    console.error('[Audit] Error:', error.message);
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'An unexpected error occurred during the audit.',
    }), { status: 500, headers });
  }
}
```

That's the complete 349-line file — every line included, nothing collapsed.
