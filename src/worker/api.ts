import { getTemplate, sendAdhoc } from "./email";
import type { Env } from "./types";
import {
  email,
  HttpError,
  id,
  isAllowedSender,
  json,
  nowIso,
  parseStringArray,
  positiveInt,
  readJson,
  safeName,
} from "./utils";

const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

export async function handleApi(request: Request, env: Env, user: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/health") return json({ ok: true, service: "mailchannels-mass-email-system" });
  if (method === "GET" && path === "/me") return json({ email: user, authMode: env.AUTH_MODE });
  if (method === "GET" && path === "/dashboard") return dashboard(env);

  if (path === "/templates" && method === "GET") return listTemplates(env);
  if (path === "/templates" && method === "POST") return createTemplate(request, env);
  const templateName = match(path, "/templates/");
  if (templateName && method === "GET") return templateResponse(env, templateName);
  if (templateName && method === "PUT") return updateTemplate(request, env, templateName);
  if (templateName && method === "DELETE") return deleteTemplate(env, templateName);

  if (path === "/recipients-lists" && method === "GET") return listRecipientLists(env);
  const listId = match(path, "/recipients-lists/");
  if (listId && method === "DELETE") return deleteRecipientList(env, listId);
  if (path === "/generate-upload-url" && method === "GET") return generateRecipientUpload(url, request, env);

  if (path === "/attachments" && method === "GET") return listAttachments(env);
  if (path === "/attachments/upload-url" && method === "POST") return generateAttachmentUpload(request, env);
  const attachmentId = match(path, "/attachments/");
  if (attachmentId && method === "DELETE") return deleteAttachment(env, attachmentId);
  const uploadToken = match(path, "/uploads/");
  if (uploadToken && method === "PUT") return acceptUpload(request, env, uploadToken);

  if (path === "/campaigns" && method === "GET") return listCampaigns(url, env);
  if (path === "/campaigns" && method === "POST") return createCampaign(request, env);
  const campaignId = match(path, "/campaigns/");
  if (campaignId && method === "GET") return campaignDetail(url, env, campaignId);
  if (campaignId && method === "PUT") return renameCampaign(request, env, campaignId);

  if (path === "/send-email" && method === "POST") return sendEmail(request, env);
  if (path === "/topics" && method === "GET") return topics(env);
  if (path === "/senders" && method === "GET") return senders(env);
  if (path === "/suppressions" && method === "GET") return suppressions(url, env);
  if (path === "/admin/repair" && method === "POST") {
    await env.CAMPAIGN_QUEUE.send({ type: "repair" });
    return json({ queued: true }, { status: 202 });
  }
  throw new HttpError(404, "API route not found");
}

async function dashboard(env: Env): Promise<Response> {
  const [campaigns, recipients, templates, recent] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM campaigns"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM recipients"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM templates"),
    env.DB.prepare(`SELECT COALESCE(SUM(delivered_count), 0) AS delivered,
      COALESCE(SUM(bounced_count), 0) AS bounced, COALESCE(SUM(failed_count), 0) AS failed FROM campaigns`),
  ]);
  return json({
    campaigns: valueCount(campaigns),
    recipients: valueCount(recipients),
    templates: valueCount(templates),
    delivery: recent.results[0] ?? { delivered: 0, bounced: 0, failed: 0 },
  });
}

async function listTemplates(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT name, subject, text_body, html_body, created_at, updated_at FROM templates ORDER BY name",
  ).all();
  return json({ templates: result.results });
}

async function templateResponse(env: Env, name: string): Promise<Response> {
  const template = await env.DB.prepare(
    "SELECT name, subject, text_body, html_body, created_at, updated_at FROM templates WHERE name = ?1",
  ).bind(decodeURIComponent(name)).first();
  if (!template) throw new HttpError(404, "Template not found");
  return json({ template });
}

async function createTemplate(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const name = safeName(String(body.name ?? ""), 80);
  const fields = templateFields(body);
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO templates (name, subject, text_body, html_body, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(name, fields.subject, fields.text, fields.html, now).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "A template with this name already exists");
    throw error;
  }
  return json({ template: { name, ...fields, created_at: now, updated_at: now } }, { status: 201 });
}

async function updateTemplate(request: Request, env: Env, encodedName: string): Promise<Response> {
  const name = decodeURIComponent(encodedName);
  const body = await readJson<Record<string, unknown>>(request);
  const fields = templateFields(body);
  const result = await env.DB.prepare(
    "UPDATE templates SET subject = ?2, text_body = ?3, html_body = ?4, updated_at = ?5 WHERE name = ?1",
  ).bind(name, fields.subject, fields.text, fields.html, nowIso()).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Template not found");
  return templateResponse(env, encodedName);
}

async function deleteTemplate(env: Env, encodedName: string): Promise<Response> {
  try {
    const result = await env.DB.prepare("DELETE FROM templates WHERE name = ?1").bind(decodeURIComponent(encodedName)).run();
    if (result.meta.changes !== 1) throw new HttpError(404, "Template not found");
  } catch (error) {
    if (String(error).includes("FOREIGN KEY")) throw new HttpError(409, "Template is referenced by a campaign and cannot be deleted");
    throw error;
  }
  return new Response(null, { status: 204 });
}

function templateFields(body: Record<string, unknown>): { subject: string; text: string; html: string } {
  const subject = String(body.subject ?? "").trim();
  const text = String(body.text ?? body.text_body ?? "");
  const html = String(body.html ?? body.html_body ?? "");
  if (!subject || subject.length > 998) throw new HttpError(400, "Subject is required and must be at most 998 characters");
  if (!text && !html) throw new HttpError(400, "Template must include text or HTML content");
  return { subject, text, html };
}

async function listRecipientLists(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT id, name, original_filename, status, recipient_count, error, created_at, updated_at
       FROM recipient_lists ORDER BY created_at DESC`,
  ).all();
  return json({ recipientLists: result.results });
}

async function generateRecipientUpload(url: URL, request: Request, env: Env): Promise<Response> {
  const filename = safeFilename(url.searchParams.get("filename") ?? "recipients.csv");
  if (!filename.toLowerCase().endsWith(".csv")) throw new HttpError(400, "Recipient list must be a CSV file");
  const listName = safeName(url.searchParams.get("name") ?? filename.replace(/\.csv$/i, ""));
  const listId = id("list");
  const token = id("upload");
  const objectKey = `recipient-lists/${listId}/${filename}`;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recipient_lists (id, name, original_filename, object_key, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'UPLOADING', ?5, ?5)`,
    ).bind(listId, listName, filename, objectKey, now),
    env.DB.prepare(
      `INSERT INTO upload_tokens (token, kind, object_key, filename, content_type, list_id, expires_at)
       VALUES (?1, 'recipient-list', ?2, ?3, 'text/csv', ?4, ?5)`,
    ).bind(token, objectKey, filename, listId, Math.floor(Date.now() / 1000) + 900),
  ]);
  return uploadResponse(request, token, listId);
}

async function generateAttachmentUpload(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const filename = safeFilename(String(body.filename ?? "attachment"));
  const contentType = String(body.contentType ?? "application/octet-stream").trim().slice(0, 255);
  const attachmentId = id("att");
  const token = id("upload");
  const objectKey = `attachments/${attachmentId}/${filename}`;
  await env.DB.prepare(
    `INSERT INTO upload_tokens (token, kind, object_key, filename, content_type, expires_at)
     VALUES (?1, 'attachment', ?2, ?3, ?4, ?5)`,
  ).bind(token, objectKey, filename, contentType, Math.floor(Date.now() / 1000) + 900).run();
  return uploadResponse(request, token, attachmentId);
}

function uploadResponse(request: Request, token: string, idValue: string): Response {
  const base = new URL(request.url);
  const uploadUrl = `${base.origin}/api/uploads/${encodeURIComponent(token)}`;
  return json({ uploadUrl, method: "PUT", expiresIn: 900, resourceId: idValue });
}

async function acceptUpload(request: Request, env: Env, token: string): Promise<Response> {
  const record = await env.DB.prepare(
    `SELECT token, kind, object_key, filename, content_type, list_id, expires_at, used_at
       FROM upload_tokens WHERE token = ?1`,
  ).bind(token).first<Record<string, string | number | null>>();
  if (!record || record.used_at || Number(record.expires_at) < Math.floor(Date.now() / 1000)) throw new HttpError(404, "Upload URL is invalid or expired");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_BYTES) throw new HttpError(413, "Upload exceeds the 95 MB sample limit");
  if (!request.body) throw new HttpError(400, "Upload body is required");
  const object = await env.CONTENT.put(String(record.object_key), request.body, {
    httpMetadata: { contentType: String(record.content_type) },
    customMetadata: { originalFilename: String(record.filename), kind: String(record.kind) },
  });
  if (object.size > MAX_UPLOAD_BYTES) {
    await env.CONTENT.delete(String(record.object_key));
    throw new HttpError(413, "Upload exceeds the 95 MB sample limit");
  }
  const now = nowIso();
  if (record.kind === "recipient-list") {
    await env.DB.batch([
      env.DB.prepare("UPDATE upload_tokens SET used_at = ?2 WHERE token = ?1 AND used_at IS NULL").bind(token, Math.floor(Date.now() / 1000)),
      env.DB.prepare("UPDATE recipient_lists SET status = 'PROCESSING', updated_at = ?2 WHERE id = ?1").bind(record.list_id, now),
    ]);
    await env.CAMPAIGN_QUEUE.send({ type: "import-list", listId: String(record.list_id), expectedOffset: 0 });
    return json({ accepted: true, listId: record.list_id, size: object.size }, { status: 202 });
  }
  const attachmentId = String(record.object_key).split("/")[1];
  await env.DB.batch([
    env.DB.prepare("UPDATE upload_tokens SET used_at = ?2 WHERE token = ?1 AND used_at IS NULL").bind(token, Math.floor(Date.now() / 1000)),
    env.DB.prepare(
      `INSERT INTO attachments (id, filename, content_type, size, object_key, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(attachmentId, record.filename, record.content_type, object.size, record.object_key, now),
  ]);
  return json({ accepted: true, attachmentId, size: object.size }, { status: 201 });
}

async function deleteRecipientList(env: Env, listId: string): Promise<Response> {
  const list = await env.DB.prepare("SELECT object_key FROM recipient_lists WHERE id = ?1").bind(listId).first<{ object_key: string }>();
  if (!list) throw new HttpError(404, "Recipient list not found");
  try { await env.DB.prepare("DELETE FROM recipient_lists WHERE id = ?1").bind(listId).run(); }
  catch (error) {
    if (String(error).includes("FOREIGN KEY")) throw new HttpError(409, "Recipient list is referenced by a campaign and cannot be deleted");
    throw error;
  }
  await env.CONTENT.delete(list.object_key);
  return new Response(null, { status: 204 });
}

async function listAttachments(env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT id, filename, content_type, size, content_id, created_at FROM attachments ORDER BY created_at DESC").all();
  return json({ attachments: result.results });
}

async function deleteAttachment(env: Env, attachmentId: string): Promise<Response> {
  const item = await env.DB.prepare("SELECT object_key FROM attachments WHERE id = ?1").bind(attachmentId).first<{ object_key: string }>();
  if (!item) throw new HttpError(404, "Attachment not found");
  await env.DB.prepare("DELETE FROM attachments WHERE id = ?1").bind(attachmentId).run();
  await env.CONTENT.delete(item.object_key);
  return new Response(null, { status: 204 });
}

async function listCampaigns(url: URL, env: Env): Promise<Response> {
  const limit = positiveInt(url.searchParams.get("limit") ?? undefined, 50, 100);
  const cursor = url.searchParams.get("cursor") ?? "9999-12-31T23:59:59.999Z";
  const result = await env.DB.prepare(
    `SELECT id, name, list_id, list_name, template_name, sender_email, status, total_count,
            pending_count, accepted_count, delivered_count, bounced_count, complained_count,
            opened_count, clicked_count, unsubscribed_count, failed_count,
            created_at, started_at, completed_at, updated_at
       FROM campaigns WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2`,
  ).bind(cursor, limit + 1).all();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1) as { created_at?: string } | undefined;
  return json({ campaigns: rows, nextCursor: result.results.length > limit ? last?.created_at : null });
}

async function createCampaign(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const listId = String(body.recipientListId ?? body.listId ?? "");
  const templateName = String(body.templateName ?? "");
  const senderEmail = email(body.senderEmail, "senderEmail");
  if (!isAllowedSender(senderEmail, env.ALLOWED_SENDER_DOMAINS)) throw new HttpError(400, "Sender domain is not allowed");
  const senderName = String(body.senderName ?? "").trim().slice(0, 120);
  const replyTo = body.replyTo ? email(body.replyTo, "replyTo") : null;
  const topic = body.topic ? String(body.topic).trim().slice(0, 120) : null;
  const attachmentIds = parseStringArray(body.attachmentIds, "attachmentIds");
  const name = body.name || body.campaignName ? safeName(String(body.name ?? body.campaignName), 120) : null;
  const list = await env.DB.prepare("SELECT id, name, status FROM recipient_lists WHERE id = ?1").bind(listId).first<{ id: string; name: string; status: string }>();
  if (!list) throw new HttpError(404, "Recipient list not found");
  if (list.status !== "READY") throw new HttpError(409, "Recipient list is not ready");
  if (!(await getTemplate(env, templateName))) throw new HttpError(404, "Template not found");
  if (attachmentIds.length) await assertAttachments(env, attachmentIds);

  const countQuery = topic
    ? `SELECT COUNT(*) AS count FROM recipients r LEFT JOIN suppressions s ON s.email = r.email
       WHERE r.list_id = ?1 AND s.email IS NULL AND EXISTS (SELECT 1 FROM json_each(r.topics_json) WHERE value = ?2)`
    : `SELECT COUNT(*) AS count FROM recipients r LEFT JOIN suppressions s ON s.email = r.email
       WHERE r.list_id = ?1 AND s.email IS NULL`;
  const countRow = topic
    ? await env.DB.prepare(countQuery).bind(listId, topic).first<{ count: number }>()
    : await env.DB.prepare(countQuery).bind(listId).first<{ count: number }>();
  const total = Number(countRow?.count ?? 0);
  if (total === 0) throw new HttpError(400, "Recipient list contains no eligible recipients");
  const campaignId = id("cmp");
  const now = nowIso();
  const retention = positiveInt(env.TRACKING_RETENTION_DAYS, 400, 3650);
  const expires = Math.floor(Date.now() / 1000) + retention * 86400;
  await env.DB.prepare(
    `INSERT INTO campaigns
      (id, name, list_id, list_name, template_name, sender_email, sender_name, reply_to, topic,
       transactional, enable_tracking, attachment_ids_json, status, total_count, pending_count,
       created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'PREPARING', ?13, ?13, ?14, ?14, ?15)`,
  ).bind(campaignId, name, listId, list.name, templateName, senderEmail, senderName, replyTo, topic,
    body.transactional === true ? 1 : 0, body.enableTracking === true ? 1 : 0,
    JSON.stringify(attachmentIds), total, now, expires).run();
  await env.CAMPAIGN_QUEUE.send({ type: "expand-campaign", campaignId, expectedCursor: 0 });
  return json({ campaignId, status: "PREPARING", totalRecipients: total }, { status: 202 });
}

async function campaignDetail(url: URL, env: Env, campaignId: string): Promise<Response> {
  const campaign = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?1").bind(campaignId).first<Record<string, unknown>>();
  if (!campaign) throw new HttpError(404, "Campaign not found");
  const limit = positiveInt(url.searchParams.get("limit") ?? undefined, 50, 200);
  const cursor = url.searchParams.get("cursor") ?? "";
  const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
  let recipientQuery = `SELECT id, email, status, attempts, mailchannels_request_id, smtp_id,
    last_event, last_error, accepted_at, delivered_at, opened_at, clicked_at, updated_at
    FROM campaign_recipients WHERE campaign_id = ?1`;
  const bindings: unknown[] = [campaignId];
  if (search) { recipientQuery += ` AND email LIKE ?${bindings.length + 1} ESCAPE '\\'`; bindings.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`); }
  if (cursor) { recipientQuery += ` AND id > ?${bindings.length + 1}`; bindings.push(cursor); }
  recipientQuery += ` ORDER BY id LIMIT ?${bindings.length + 1}`;
  bindings.push(limit + 1);
  const [batches, recipients] = await Promise.all([
    env.DB.prepare("SELECT * FROM campaign_batches WHERE campaign_id = ?1 ORDER BY sequence").bind(campaignId).all(),
    env.DB.prepare(recipientQuery).bind(...bindings).all(),
  ]);
  const rows = recipients.results.slice(0, limit);
  const last = rows.at(-1) as { id?: string } | undefined;
  return json({ campaign, batches: batches.results, recipients: rows, nextCursor: recipients.results.length > limit ? last?.id : null });
}

async function renameCampaign(request: Request, env: Env, campaignId: string): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const name = body.name === null || body.name === "" ? null : safeName(String(body.name ?? ""), 120);
  const result = await env.DB.prepare("UPDATE campaigns SET name = ?2, updated_at = ?3 WHERE id = ?1").bind(campaignId, name, nowIso()).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Campaign not found");
  return json({ campaignId, name });
}

async function sendEmail(request: Request, env: Env): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const to = email(body.to ?? body.recipientEmail, "to");
  const from = email(body.from ?? body.senderEmail, "from");
  const templateName = body.templateName ? String(body.templateName) : undefined;
  const template = templateName ? await getTemplate(env, templateName) : undefined;
  if (templateName && !template) throw new HttpError(404, "Template not found");
  const attachmentIds = parseStringArray(body.attachmentIds, "attachmentIds");
  const sendId = id("send");
  const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO adhoc_sends (id, recipient_email, template_name, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'SENDING', ?4, ?4)",
  ).bind(sendId, to, templateName ?? null, now).run();
  try {
    const result = await sendAdhoc(env, {
      to, from, fromName: String(body.fromName ?? body.senderName ?? ""),
      replyTo: body.replyTo ? email(body.replyTo, "replyTo") : undefined,
      template: template ?? undefined,
      subject: String(body.subject ?? ""), text: String(body.text ?? ""), html: String(body.html ?? ""),
      data: isRecord(body.data) ? body.data : {}, attachmentIds,
    });
    await env.DB.prepare("UPDATE adhoc_sends SET request_id = ?2, status = 'ACCEPTED', updated_at = ?3 WHERE id = ?1")
      .bind(sendId, result.request_id, nowIso()).run();
    return json({ sendId, requestId: result.request_id, queuedAt: result.queued_at }, { status: 202 });
  } catch (error) {
    await env.DB.prepare("UPDATE adhoc_sends SET status = 'FAILED', error = ?2, updated_at = ?3 WHERE id = ?1")
      .bind(sendId, String(error).slice(0, 1000), nowIso()).run();
    throw error;
  }
}

async function topics(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT DISTINCT value AS topic FROM recipients, json_each(recipients.topics_json) WHERE value <> '' ORDER BY value",
  ).all();
  return json({ topics: result.results.map((row) => (row as { topic: string }).topic) });
}

function senders(env: Env): Response {
  const domains = (env.ALLOWED_SENDER_DOMAINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return json({ domains, note: "MailChannels Domain Lockdown is the source of truth for authorized sending domains." });
}

async function suppressions(url: URL, env: Env): Promise<Response> {
  const limit = positiveInt(url.searchParams.get("limit") ?? undefined, 100, 500);
  const result = await env.DB.prepare("SELECT email, reason, created_at FROM suppressions ORDER BY created_at DESC LIMIT ?1").bind(limit).all();
  return json({ suppressions: result.results });
}

async function assertAttachments(env: Env, ids: string[]): Promise<void> {
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM attachments WHERE id IN (${placeholders})`).bind(...ids).first<{ count: number }>();
  if (Number(row?.count ?? 0) !== ids.length) throw new HttpError(400, "One or more attachments do not exist");
}

function safeFilename(value: string): string {
  const filename = value.trim().replace(/[^A-Za-z0-9._() -]/g, "_").replace(/^\.+/, "").slice(0, 180);
  if (!filename) throw new HttpError(400, "Filename is required");
  return filename;
}

function match(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix) || path.length <= prefix.length || path.slice(prefix.length).includes("/")) return null;
  return path.slice(prefix.length);
}

function valueCount(result: D1Result): number {
  const row = result.results[0] as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
