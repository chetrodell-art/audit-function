/**
 * Serverless Function: Claude-Powered Website Audit
 * ANTHROPIC_API_KEY = sk-ant-... (Vercel env var)
 * CRM_API_KEY       = pit-...    (Vercel env var)
 */

export const config = { maxDuration: 60 };

interface AuditRequest {
  contactId?: string;
  firstName: string;
  lastName?: string;
  email: string;
  phone?: string;
  website: string;
}

async function callClaude(target: string): Promise<{ summaryHtml: string; fullReport: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1200,
        system: `You are a senior SEO and web performance consultant auditing a website for a potential client.

Return your response in EXACTLY this format:

===EMAIL_SUMMARY===
Write 4-5 findings as HTML using ONLY <ul> and <li> tags. Each <li> should have a bold finding title followed by one specific recommendation. Friendly tone, written for a business owner. No extra HTML tags, no styling attributes.

===FULL_REPORT===
Full detailed audit in clean markdown. Include: Executive Summary, Performance Scores (estimated), Key Issues (5-8 ordered by severity), Recommendations (5-8 actionable items), Conversion Opportunities.`,
        messages: [{ role: 'user', content: `Audit this website: ${target}` }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`Claude error ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const raw: string = data?.content?.[0]?.text;
    if (!raw) throw new Error('Empty response from Claude');

    const summaryMatch = raw.match(/===EMAIL_SUMMARY===([\s\S]*?)===FULL_REPORT===/);
    const fullMatch = raw.match(/===FULL_REPORT===([\s\S]*)/);

    const summaryHtml = summaryMatch?.[1]?.trim() ?? '<ul><li>Audit complete — see full report in your CRM notes.</li></ul>';
    const fullReport = fullMatch?.[1]?.trim() ?? raw;

    return { summaryHtml, fullReport };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('Claude timed out after 25s');
    throw err;
  }
}

const CRM_BASE = 'https://services.leadconnectorhq.com';
const AUDIT_SUMMARY_FIELD_ID = 'BWWIBWHOzsF67mN1IjJJ';
const BOOKING_LINK = 'https://api.leadconnectorhq.com/widget/booking/bookwithuswebdesign-fb89806c-32ca-4c6c-adb0-2b1e3b824fe3';

async function sendAuditEmail(contactId: string, firstName: string, website: string, summaryHtml: string): Promise<void> {
  const key = process.env.CRM_API_KEY;
  if (!key) throw new Error('CRM_API_KEY not set');

  const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
  <p>Hi ${firstName},</p>
  <p>Your free website audit for ${website} is ready — here's a summary of what we found:</p>
  ${summaryHtml}
  <hr style="border: none; border-top: 1px solid #eee; margin: 28px 0;">
  <p>Our solutions are unique to each client, so we like to go over the findings in more depth and ask you questions about your business to find ways we can help.</p>
  <p><strong>Book a free 30-minute strategy call here, it's free:</strong></p>
  <p>
    <a href="${BOOKING_LINK}"
       style="display: inline-block; background: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
      Book My Free Strategy Call
    </a>
  </p>
  <p>Even if you don't decide to work with us, the call will help your business.</p>
  <br>
  <p>Talk soon,<br>
  <strong>The Framework Digital Team</strong><br>
  <a href="https://www.frameworkdigitaldesign.com" style="color: #2563eb;">frameworkdigitaldesign.com</a></p>
</div>`;

  const res = await fetch(`${CRM_BASE}/conversations/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'Version': '2021-07-28',
    },
    body: JSON.stringify({
      type: 'Email',
      contactId,
      subject: 'Your Free Website Audit is Ready',
      html,
      status: 'sent',
    }),
  });
  if (!res.ok) throw new Error(`Email send failed ${res.status}: ${await res.text()}`);
}

async function addNoteToContact(contactId: string, report: string, firstName: string, website: string): Promise<void> {
  const key = process.env.CRM_API_KEY;
  if (!key) throw new Error('CRM_API_KEY not set');
  const res = await fetch(`${CRM_BASE}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Version': '2021-07-28' },
    body: JSON.stringify({ body: `AI Website Audit — ${website}\n\n${report}\n\n---\nGenerated by Framework Digital AI audit system for ${firstName}.` }),
  });
  if (!res.ok) throw new Error(`Note failed ${res.status}: ${await res.text()}`);
}

async function updateContactSummaryField(contactId: string, summaryHtml: string): Promise<void> {
  const key = process.env.CRM_API_KEY;
  if (!key) throw new Error('CRM_API_KEY not set');
  const res = await fetch(`${CRM_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Version': '2021-07-28' },
    body: JSON.stringify({ customFields: [{ id: AUDIT_SUMMARY_FIELD_ID, value: summaryHtml }] }),
  });
  if (!res.ok) throw new Error(`Custom field update failed ${res.status}: ${await res.text()}`);
}

async function addTagToContact(contactId: string, tag: string): Promise<void> {
  const key = process.env.CRM_API_KEY;
  if (!key) throw new Error('CRM_API_KEY not set');
  const res = await fetch(`${CRM_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Version': '2021-07-28' },
    body: JSON.stringify({ tags: [tag] }),
  });
  if (!res.ok) throw new Error(`Tag failed ${res.status}: ${await res.text()}`);
}

async function createContact(data: { firstName: string; lastName?: string; email: string; phone?: string; website: string }): Promise<string> {
  const key = process.env.CRM_API_KEY;
  if (!key) throw new Error('CRM_API_KEY not set');
  const res = await fetch(`${CRM_BASE}/contacts/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Version': '2021-07-28' },
    body: JSON.stringify({
      firstName: data.firstName,
      lastName: data.lastName || '',
      email: data.email,
      phone: data.phone || '',
      website: data.website,
      locationId: 'OUrWlaebgMJpay1aHLiC',
    }),
  });
  if (!res.ok) throw new Error(`Contact creation failed ${res.status}: ${await res.text()}`);
  const result = await res.json();
  const id = result?.contact?.id || result?.id;
  if (!id) throw new Error('No contactId returned');
  return id;
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request): Promise<Response> {
  try {
    let body: AuditRequest;
    try { body = JSON.parse(await req.text()); }
    catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders }); }

    const { contactId: passedId, firstName, lastName, email, phone, website } = body;
    if (!website || !email) return new Response(JSON.stringify({ error: 'email and website required' }), { status: 400, headers: corsHeaders });

    let contactId = passedId;
    if (!contactId) {
      contactId = await createContact({ firstName, lastName, email, phone, website });
    }

    let target = website.trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

    console.log(`[Audit] Calling Claude for ${target}`);
    const { summaryHtml, fullReport } = await callClaude(target);
    console.log(`[Audit] Claude done — summary: ${summaryHtml.length} chars, report: ${fullReport.length} chars`);

    await addNoteToContact(contactId, fullReport, firstName, target);
    await updateContactSummaryField(contactId, summaryHtml);
    await sendAuditEmail(contactId, firstName, target, summaryHtml);
    await addTagToContact(contactId, 'audit-complete');
    console.log('[Audit] Complete.');

    return new Response(JSON.stringify({ success: true, contactId, website: target }), { status: 200, headers: corsHeaders });

  } catch (error: any) {
    console.error('[Audit] ERROR:', error.message);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
