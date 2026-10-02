import { publicOrigin } from "./control/sessions";
import { signToken } from "./control/crypto";
import type { TenantContext } from "./types";
import {
  base64FromBytes,
  HttpError,
  isAllowedSender,
  nowIso,
  parseJsonArray,
} from "./utils";

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
  first_name: string;
  last_name: string;
  topics_json: string;
  campaign_id: string;
  batch_id: string;
  sender_email: string;
  sender_name: string;
  reply_to: string | null;
  attachment_ids_json: string;
  transactional: number;
  enable_tracking: number;
  status: string;
  paused: number;
}

interface AsyncResponse {
  request_id: string;
  queued_at: string;
}

export class RetryableEmailError extends Error {
  constructor(
    message: string,
    public delaySeconds = 30,
  ) {
    super(message);
  }
}

export async function sendCampaignRecipient(
  env: TenantContext,
  recipientId: string,
): Promise<"sent" | "skipped"> {
  if (env.accountStatus !== "ACTIVE") return "skipped";
  const row = await env.STORE.prepare(
    `SELECT cr.id AS recipient_id, cr.email, r.data_json, r.first_name, r.last_name, r.topics_json, cr.status, cr.batch_id,
            c.id AS campaign_id, c.sender_email, c.sender_name, c.reply_to,
            c.attachment_ids_json, c.transactional, c.enable_tracking, c.paused,
            t.name, t.subject, t.text_body, t.html_body
       FROM campaign_recipients cr
       JOIN campaigns c ON c.id = cr.campaign_id
       JOIN templates t ON t.name = c.template_name
       JOIN recipients r ON r.id = cr.source_recipient_id
      WHERE cr.id = ?1`,
  )
    .bind(recipientId)
    .first<CampaignSendRow>();
  if (!row || row.status !== "PENDING" || row.paused) return "skipped";

  const suppressed = await env.STORE.prepare(
    "SELECT email FROM suppressions WHERE email=?1",
  )
    .bind(row.email)
    .first();
  if (suppressed) {
    await env.STORE.batch([
      env.STORE.prepare(
        "UPDATE campaign_recipients SET status='SUPPRESSED',updated_at=?2 WHERE id=?1 AND status='PENDING'",
      ).bind(recipientId, nowIso()),
      env.STORE.prepare(
        "UPDATE campaigns SET pending_count=MAX(0,pending_count-1) WHERE id=?1",
      ).bind(row.campaign_id),
    ]);
    await maybeCompleteCampaign(env, row.campaign_id);
    return "skipped";
  }
  const volume = await env.STORE.prepare(
    "SELECT COUNT(*) AS total FROM campaign_recipients WHERE (accepted_at>=?1 OR status='SENDING')",
  )
    .bind(
      new Date(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        1,
      ).toISOString(),
    )
    .first<{ total: number }>();
  if (Number(volume?.total ?? 0) >= env.monthlyLimit) return "skipped";
  const claim = await env.STORE.prepare(
    `UPDATE campaign_recipients
        SET status = 'SENDING', attempts = attempts + 1, updated_at = ?2
      WHERE id = ?1 AND status = 'PENDING'`,
  )
    .bind(recipientId, nowIso())
    .run();
  if (claim.meta.changes !== 1) return "skipped";

  try {
    const payload = await buildPayload(env, {
      to: row.email,
      from: row.sender_email,
      fromName: row.sender_name,
      replyTo: row.reply_to ?? undefined,
      template: row,
      data: {
        ...JSON.parse(row.data_json || "{}"),
        firstName: row.first_name,
        lastName: row.last_name,
        topics: JSON.parse(row.topics_json),
      },
      attachmentIds: parseJsonArray(row.attachment_ids_json),
      campaignId: row.campaign_id,
      transactional: Boolean(row.transactional),
      enableTracking: Boolean(row.enable_tracking),
    });
    const result = await postMailChannels(env, payload);
    const now = nowIso();
    await env.STORE.batch([
      env.STORE.prepare(
        `UPDATE campaign_recipients SET status='ACCEPTED',mailchannels_request_id=?2,accepted_at=?3,last_error=NULL,updated_at=?3 WHERE id=?1 AND status='SENDING'`,
      ).bind(recipientId, result.request_id, now),
      env.STORE.prepare(
        `UPDATE campaigns SET accepted_count=accepted_count+1,pending_count=MAX(0,pending_count-1),updated_at=?2 WHERE id=?1 AND changes()=1`,
      ).bind(row.campaign_id, now),
      env.STORE.prepare(
        `UPDATE campaign_batches SET queued_count=queued_count+1,terminal_count=terminal_count+1,status=CASE WHEN terminal_count+1>=recipient_count THEN 'COMPLETE' ELSE 'RUNNING' END,updated_at=?2 WHERE id=?1 AND changes()=1`,
      ).bind(row.batch_id, now),
    ]);
    await maybeCompleteCampaign(env, row.campaign_id);
    return "sent";
  } catch (error) {
    if (error instanceof RetryableEmailError) {
      await env.STORE.prepare(
        `UPDATE campaign_recipients SET status = 'PENDING', last_error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'SENDING'`,
      )
        .bind(recipientId, error.message.slice(0, 1000), nowIso())
        .run();
      throw error;
    }
    if (!(error instanceof HttpError)) {
      // Network errors and crashes after acceptance are ambiguous: leave SENDING for reconciliation.
      await env.STORE.prepare(
        "UPDATE campaign_recipients SET last_error=?2 WHERE id=?1",
      )
        .bind(recipientId, "Awaiting delivery reconciliation")
        .run();
      return "skipped";
    }
    const message =
      error instanceof Error ? error.message : "Unknown delivery error";
    const now = nowIso();
    await env.STORE.batch([
      env.STORE.prepare(
        `UPDATE campaign_recipients SET status='FAILED',last_error=?2,failed_at=?3,updated_at=?3 WHERE id=?1 AND status='SENDING'`,
      ).bind(recipientId, message.slice(0, 1000), now),
      env.STORE.prepare(
        `UPDATE campaigns SET failed_count=failed_count+1,pending_count=MAX(0,pending_count-1),updated_at=?2 WHERE id=?1 AND changes()=1`,
      ).bind(row.campaign_id, now),
      env.STORE.prepare(
        `UPDATE campaign_batches SET failed_count=failed_count+1,terminal_count=terminal_count+1,status=CASE WHEN terminal_count+1>=recipient_count THEN 'COMPLETE' ELSE 'RUNNING' END,updated_at=?2 WHERE id=?1 AND changes()=1`,
      ).bind(row.batch_id, now),
    ]);
    await maybeCompleteCampaign(env, row.campaign_id);
    return "sent";
  }
}

export async function sendAdhoc(
  env: TenantContext,
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
  if (env.accountStatus !== "ACTIVE")
    throw new HttpError(403, "Account is not active");
  const testLimiter = env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName("test:" + env.accountId),
  );
  const allowed = await testLimiter.fetch("https://limiter/acquire", {
    method: "POST",
    body: JSON.stringify({ rate: 1 / 60, burst: 3 }),
  });
  if (!allowed.ok)
    throw new HttpError(429, "Please wait before sending another test");
  if (!isAllowedSender(options.from, env.ALLOWED_SENDER_DOMAINS))
    throw new HttpError(400, "Sender domain is not allowed");
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

export async function getTemplate(
  env: TenantContext,
  name: string,
): Promise<TemplateRow | null> {
  return env.STORE.prepare(
    "SELECT name, subject, text_body, html_body FROM templates WHERE name = ?1",
  )
    .bind(name)
    .first<TemplateRow>();
}

async function buildPayload(
  env: TenantContext,
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
  if (!isAllowedSender(options.from, env.ALLOWED_SENDER_DOMAINS))
    throw new HttpError(400, "Sender domain is not verified");
  let unsubscribeUrl = "";
  if (options.campaignId) {
    if (!env.SESSION_SECRET || !env.publicHost || !env.postalAddress)
      throw new HttpError(400, "Sender settings are incomplete");
    unsubscribeUrl = `${publicOrigin(env, env.publicHost)}/unsubscribe?token=${await signToken(env.SESSION_SECRET, { purpose: "unsubscribe", accountId: env.accountId, email: options.to, host: env.publicHost })}`;
    options.data = {
      ...options.data,
      unsubscribe_url: unsubscribeUrl,
      postal_address: env.postalAddress,
    };
    options.template = {
      ...options.template,
      text_body: options.template.text_body
        ? options.template.text_body +
          "\n\n{{postal_address}}\nUnsubscribe: {{unsubscribe_url}}"
        : "",
      html_body: options.template.html_body
        ? options.template.html_body +
          '<footer><p>{{postal_address}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a></footer>'
        : "",
    };
  }
  const content: Record<string, unknown>[] = [];
  if (options.template.text_body)
    content.push({
      type: "text/plain",
      value: options.template.text_body,
      template_type: "mustache",
    });
  if (options.template.html_body)
    content.push({
      type: "text/html",
      value: options.template.html_body,
      template_type: "mustache",
    });
  if (content.length === 0)
    throw new HttpError(400, "Template must contain text or HTML content");

  const attachments = await loadAttachments(env, options.attachmentIds);
  const payload: Record<string, unknown> = {
    personalizations: [
      {
        to: [{ email: options.to }],
        dynamic_template_data: { ...options.data, email: options.to },
      },
    ],
    from: {
      email: options.from,
      ...(options.fromName ? { name: options.fromName } : {}),
    },
    // MailChannels applies Mustache to content parts. Render common scalar
    // subject placeholders here so SES-style subject personalization is retained.
    subject: renderSubject(options.template.subject, options.data),
    content,
    transactional: options.transactional,
  };
  if (unsubscribeUrl)
    payload.headers = {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  if (options.replyTo) payload.reply_to = { email: options.replyTo };
  if (options.campaignId) payload.campaign_id = options.campaignId;
  if (
    options.enableTracking &&
    env.trackingDomains.open &&
    env.trackingDomains.click
  )
    payload.tracking_settings = {
      open_tracking: {
        enable: true,
        custom_domain_name: env.trackingDomains.open,
      },
      click_tracking: {
        enable: true,
        custom_domain_name: env.trackingDomains.click,
      },
    };
  if (attachments.length) payload.attachments = attachments;
  return payload;
}

async function loadAttachments(
  env: TenantContext,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  if (ids.length > 20)
    throw new HttpError(
      400,
      "At most 20 attachments are supported by this sample",
    );
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const result = await env.STORE.prepare(
    `SELECT id, filename, content_type, object_key, content_id, size FROM attachments WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<AttachmentRow>();
  if (result.results.length !== ids.length)
    throw new HttpError(400, "One or more attachments do not exist");
  const total = result.results.reduce((sum, item) => sum + item.size, 0);
  if (total > 20 * 1024 * 1024)
    throw new HttpError(
      413,
      "Attachments exceed this sample's 20 MB pre-encoding limit",
    );
  const output: Record<string, unknown>[] = [];
  for (const item of result.results) {
    const object = await env.CONTENT.get(item.object_key);
    if (!object)
      throw new HttpError(
        500,
        `Attachment object is missing: ${item.filename}`,
      );
    output.push({
      filename: item.filename,
      type: item.content_type,
      content: base64FromBytes(new Uint8Array(await object.arrayBuffer())),
      ...(item.content_id ? { content_id: item.content_id } : {}),
    });
  }
  return output;
}

async function postMailChannels(
  env: TenantContext,
  payload: Record<string, unknown>,
): Promise<AsyncResponse> {
  if (!env.MAILCHANNELS_API_KEY)
    throw new HttpError(500, "MAILCHANNELS_API_KEY is not configured");
  const send =
    env.LOCAL_TEST === "true" && env.PROVIDER
      ? env.PROVIDER.fetch.bind(env.PROVIDER)
      : fetch;
  const response = await send("https://api.mailchannels.net/tx/v1/send-async", {
    signal: AbortSignal.timeout(15000),
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.MAILCHANNELS_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) {
    const message = `MailChannels ${response.status}: ${body.slice(0, 800)}`;
    if (response.status === 429) {
      const retryAfter = Number.parseInt(
        response.headers.get("retry-after") ?? "",
        10,
      );
      throw new RetryableEmailError(
        message,
        Number.isFinite(retryAfter) ? Math.min(retryAfter, 600) : 30,
      );
    }
    if (response.status >= 500) throw new Error("Ambiguous provider failure");
    throw new HttpError(
      response.status >= 400 && response.status < 500 ? 400 : 502,
      message,
    );
  }
  let parsed: AsyncResponse;
  try {
    parsed = JSON.parse(body) as AsyncResponse;
  } catch {
    throw new Error("Ambiguous provider response");
  }
  if (!parsed.request_id) throw new Error("Ambiguous provider response");
  return parsed;
}

export async function maybeCompleteCampaign(
  env: TenantContext,
  campaignId: string,
): Promise<void> {
  const campaign = await env.STORE.prepare(
    "SELECT expansion_done, pending_count, failed_count, status FROM campaigns WHERE id = ?1",
  )
    .bind(campaignId)
    .first<{
      expansion_done: number;
      pending_count: number;
      failed_count: number;
      status: string;
    }>();
  if (
    !campaign ||
    !campaign.expansion_done ||
    campaign.pending_count !== 0 ||
    !["PREPARING", "RUNNING"].includes(campaign.status)
  )
    return;
  const status =
    campaign.failed_count > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
  await env.STORE.prepare(
    "UPDATE campaigns SET status = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('PREPARING','RUNNING')",
  )
    .bind(campaignId, status, nowIso())
    .run();
}

export function renderSubject(
  template: string,
  data: Record<string, unknown>,
): string {
  return template.replace(
    /{{{?\s*([A-Za-z0-9_.]+)\s*}?}}/g,
    (_match, path: string) => {
      let value: unknown = data;
      for (const part of path.split(".")) {
        if (!value || typeof value !== "object" || !(part in value)) return "";
        value = (value as Record<string, unknown>)[part];
      }
      return value === null || value === undefined || typeof value === "object"
        ? ""
        : String(value);
    },
  );
}
