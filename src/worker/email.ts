import type { Env } from "./types";
import { base64FromBytes, HttpError, isAllowedSender, nowIso, parseJsonArray } from "./utils";

interface TemplateRow {
  name: string;
  subject: string;
  text_body: string;
  html_body: string;
}

interface AttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  object_key: string;
  content_id: string | null;
  size: number;
}

interface CampaignSendRow extends TemplateRow {
  recipient_id: string;
  email: string;
  data_json: string;
  campaign_id: string;
  batch_id: string;
  sender_email: string;
  sender_name: string;
  reply_to: string | null;
  attachment_ids_json: string;
  transactional: number;
  enable_tracking: number;
  status: string;
}

interface AsyncResponse { request_id: string; queued_at: string }

export class RetryableEmailError extends Error {
  constructor(message: string, public delaySeconds = 30) { super(message); }
}

export async function sendCampaignRecipient(env: Env, recipientId: string): Promise<"sent" | "skipped"> {
  const row = await env.DB.prepare(
    `SELECT cr.id AS recipient_id, cr.email, cr.data_json, cr.status, cr.batch_id,
            c.id AS campaign_id, c.sender_email, c.sender_name, c.reply_to,
            c.attachment_ids_json, c.transactional, c.enable_tracking,
            t.name, t.subject, t.text_body, t.html_body
       FROM campaign_recipients cr
       JOIN campaigns c ON c.id = cr.campaign_id
       JOIN templates t ON t.name = c.template_name
      WHERE cr.id = ?1`,
  ).bind(recipientId).first<CampaignSendRow>();
  if (!row || row.status !== "PENDING") return "skipped";

  const claim = await env.DB.prepare(
    `UPDATE campaign_recipients
        SET status = 'SENDING', attempts = attempts + 1, updated_at = ?2
      WHERE id = ?1 AND status = 'PENDING'`,
  ).bind(recipientId, nowIso()).run();
  if (claim.meta.changes !== 1) return "skipped";

  try {
    const payload = await buildPayload(env, {
      to: row.email,
      from: row.sender_email,
      fromName: row.sender_name,
      replyTo: row.reply_to ?? undefined,
      template: row,
      data: JSON.parse(row.data_json || "{}") as Record<string, unknown>,
      attachmentIds: parseJsonArray(row.attachment_ids_json),
      campaignId: row.campaign_id,
      transactional: Boolean(row.transactional),
      enableTracking: Boolean(row.enable_tracking),
    });
    const result = await postMailChannels(env, payload);
    const changed = await env.DB.prepare(
      `UPDATE campaign_recipients
          SET status = 'ACCEPTED', mailchannels_request_id = ?2, accepted_at = ?3,
              last_error = NULL, updated_at = ?3
        WHERE id = ?1 AND status = 'SENDING'`,
    ).bind(recipientId, result.request_id, nowIso()).run();
    if (changed.meta.changes === 1) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE campaigns SET accepted_count = accepted_count + 1,
             pending_count = CASE WHEN pending_count > 0 THEN pending_count - 1 ELSE 0 END,
             updated_at = ?2 WHERE id = ?1`,
        ).bind(row.campaign_id, nowIso()),
        env.DB.prepare(
          `UPDATE campaign_batches SET queued_count = queued_count + 1,
             terminal_count = terminal_count + 1, status = CASE WHEN terminal_count + 1 >= recipient_count THEN 'COMPLETE' ELSE 'RUNNING' END,
             updated_at = ?2 WHERE id = ?1`,
        ).bind(row.batch_id, nowIso()),
      ]);
      await maybeCompleteCampaign(env, row.campaign_id);
    }
    return "sent";
  } catch (error) {
    if (error instanceof RetryableEmailError) {
      await env.DB.prepare(
        `UPDATE campaign_recipients SET status = 'PENDING', last_error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'SENDING'`,
      ).bind(recipientId, error.message.slice(0, 1000), nowIso()).run();
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown delivery error";
    const failed = await env.DB.prepare(
      `UPDATE campaign_recipients SET status = 'FAILED', last_error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'SENDING'`,
    ).bind(recipientId, message.slice(0, 1000), nowIso()).run();
    if (failed.meta.changes === 1) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE campaigns SET failed_count = failed_count + 1,
             pending_count = CASE WHEN pending_count > 0 THEN pending_count - 1 ELSE 0 END,
             updated_at = ?2 WHERE id = ?1`,
        ).bind(row.campaign_id, nowIso()),
        env.DB.prepare(
          `UPDATE campaign_batches SET failed_count = failed_count + 1, terminal_count = terminal_count + 1,
             status = CASE WHEN terminal_count + 1 >= recipient_count THEN 'COMPLETE' ELSE 'RUNNING' END,
             updated_at = ?2 WHERE id = ?1`,
        ).bind(row.batch_id, nowIso()),
      ]);
      await maybeCompleteCampaign(env, row.campaign_id);
    }
    return "sent";
  }
}

export async function sendAdhoc(
  env: Env,
  options: {
    to: string;
    from: string;
    fromName?: string;
    replyTo?: string;
    template?: TemplateRow;
    subject?: string;
    text?: string;
    html?: string;
    data?: Record<string, unknown>;
    attachmentIds?: string[];
  },
): Promise<AsyncResponse> {
  if (!isAllowedSender(options.from, env.ALLOWED_SENDER_DOMAINS)) throw new HttpError(400, "Sender domain is not allowed");
  const template = options.template ?? {
    name: "adhoc",
    subject: options.subject ?? "",
    text_body: options.text ?? "",
    html_body: options.html ?? "",
  };
  const payload = await buildPayload(env, {
    to: options.to,
    from: options.from,
    fromName: options.fromName,
    replyTo: options.replyTo,
    template,
    data: options.data ?? {},
    attachmentIds: options.attachmentIds ?? [],
    transactional: true,
    enableTracking: false,
  });
  return postMailChannels(env, payload);
}

export async function getTemplate(env: Env, name: string): Promise<TemplateRow | null> {
  return env.DB.prepare("SELECT name, subject, text_body, html_body FROM templates WHERE name = ?1").bind(name).first<TemplateRow>();
}

async function buildPayload(
  env: Env,
  options: {
    to: string;
    from: string;
    fromName?: string;
    replyTo?: string;
    template: TemplateRow;
    data: Record<string, unknown>;
    attachmentIds: string[];
    campaignId?: string;
    transactional: boolean;
    enableTracking: boolean;
  },
): Promise<Record<string, unknown>> {
  const content: Record<string, unknown>[] = [];
  if (options.template.text_body) content.push({ type: "text/plain", value: options.template.text_body, template_type: "mustache" });
  if (options.template.html_body) content.push({ type: "text/html", value: options.template.html_body, template_type: "mustache" });
  if (content.length === 0) throw new HttpError(400, "Template must contain text or HTML content");

  const attachments = await loadAttachments(env, options.attachmentIds);
  const payload: Record<string, unknown> = {
    personalizations: [{
      to: [{ email: options.to }],
      dynamic_template_data: { ...options.data, email: options.to },
    }],
    from: { email: options.from, ...(options.fromName ? { name: options.fromName } : {}) },
    // MailChannels applies Mustache to content parts. Render common scalar
    // subject placeholders here so SES-style subject personalization is retained.
    subject: renderSubject(options.template.subject, options.data),
    content,
    transactional: options.transactional,
  };
  if (options.replyTo) payload.reply_to = { email: options.replyTo };
  if (options.campaignId) payload.campaign_id = options.campaignId;
  if (options.enableTracking) payload.tracking_settings = {
    open_tracking: { enable: true },
    click_tracking: { enable: true },
  };
  if (attachments.length) payload.attachments = attachments;
  return payload;
}

async function loadAttachments(env: Env, ids: string[]): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  if (ids.length > 20) throw new HttpError(400, "At most 20 attachments are supported by this sample");
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const result = await env.DB.prepare(
    `SELECT id, filename, content_type, object_key, content_id, size FROM attachments WHERE id IN (${placeholders})`,
  ).bind(...ids).all<AttachmentRow>();
  if (result.results.length !== ids.length) throw new HttpError(400, "One or more attachments do not exist");
  const total = result.results.reduce((sum, item) => sum + item.size, 0);
  if (total > 20 * 1024 * 1024) throw new HttpError(413, "Attachments exceed this sample's 20 MB pre-encoding limit");
  const output: Record<string, unknown>[] = [];
  for (const item of result.results) {
    const object = await env.CONTENT.get(item.object_key);
    if (!object) throw new HttpError(500, `Attachment object is missing: ${item.filename}`);
    output.push({
      filename: item.filename,
      type: item.content_type,
      content: base64FromBytes(new Uint8Array(await object.arrayBuffer())),
      ...(item.content_id ? { content_id: item.content_id } : {}),
    });
  }
  return output;
}

async function postMailChannels(env: Env, payload: Record<string, unknown>): Promise<AsyncResponse> {
  if (!env.MAILCHANNELS_API_KEY) throw new HttpError(500, "MAILCHANNELS_API_KEY is not configured");
  const response = await fetch("https://api.mailchannels.net/tx/v1/send-async", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.MAILCHANNELS_API_KEY },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) {
    const message = `MailChannels ${response.status}: ${body.slice(0, 800)}`;
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      throw new RetryableEmailError(message, Number.isFinite(retryAfter) ? Math.min(retryAfter, 600) : 30);
    }
    throw new HttpError(response.status >= 400 && response.status < 500 ? 400 : 502, message);
  }
  let parsed: AsyncResponse;
  try { parsed = JSON.parse(body) as AsyncResponse; } catch { throw new RetryableEmailError("MailChannels returned invalid JSON"); }
  if (!parsed.request_id) throw new RetryableEmailError("MailChannels response did not include request_id");
  return parsed;
}

export async function maybeCompleteCampaign(env: Env, campaignId: string): Promise<void> {
  const campaign = await env.DB.prepare(
    "SELECT expansion_done, pending_count, failed_count, status FROM campaigns WHERE id = ?1",
  ).bind(campaignId).first<{ expansion_done: number; pending_count: number; failed_count: number; status: string }>();
  if (!campaign || !campaign.expansion_done || campaign.pending_count !== 0 || !["PREPARING", "RUNNING"].includes(campaign.status)) return;
  const status = campaign.failed_count > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
  await env.DB.prepare(
    "UPDATE campaigns SET status = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('PREPARING','RUNNING')",
  ).bind(campaignId, status, nowIso()).run();
}

export function renderSubject(template: string, data: Record<string, unknown>): string {
  return template.replace(/{{{?\s*([A-Za-z0-9_.]+)\s*}?}}/g, (_match, path: string) => {
    let value: unknown = data;
    for (const part of path.split(".")) {
      if (!value || typeof value !== "object" || !(part in value)) return "";
      value = (value as Record<string, unknown>)[part];
    }
    return value === null || value === undefined || typeof value === "object" ? "" : String(value);
  });
}
