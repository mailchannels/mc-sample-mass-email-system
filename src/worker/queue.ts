import { initialCsvState, parseCsvChunk, rowsToRecipients } from "./csv";
import { maybeCompleteCampaign, RetryableEmailError, sendCampaignRecipient } from "./email";
import { acquireSendPermit } from "./rate-limiter";
import type { CampaignJob, CsvParserState, Env, EventJob, MailChannelsEvent } from "./types";
import { id, nowIso, positiveInt } from "./utils";

interface ImportRow {
  id: string;
  object_key: string;
  status: string;
  import_offset: number;
  import_state_json: string;
}

interface CampaignRow {
  id: string;
  list_id: string;
  topic: string | null;
  status: string;
  expansion_cursor: number;
  expansion_done: number;
  expires_at: number | null;
}

interface SourceRecipient {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  topics_json: string;
  data_json: string;
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const body = message.body as { type?: string };
      if (body.type === "send-recipient") {
        const retryAfter = await acquireSendPermit(env);
        if (retryAfter) {
          message.retry({ delaySeconds: retryAfter });
          continue;
        }
        await sendCampaignRecipient(env, (message.body as { campaignRecipientId: string }).campaignRecipientId);
      } else if (body.type === "delivery-event") {
        await processDeliveryEvent(env, message.body as EventJob);
      } else {
        await processCampaignJob(env, message.body as CampaignJob);
      }
      message.ack();
    } catch (error) {
      console.error("Queue message failed", { id: message.id, attempts: message.attempts, error: String(error) });
      if (error instanceof RetryableEmailError) message.retry({ delaySeconds: error.delaySeconds });
      else message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
    }
  }
}

async function processCampaignJob(env: Env, job: CampaignJob): Promise<void> {
  switch (job.type) {
    case "import-list": return importRecipientList(env, job.listId, job.expectedOffset);
    case "expand-campaign": return expandCampaign(env, job.campaignId, job.expectedCursor);
    case "flush-outbox": return flushOutbox(env);
    case "repair": return repair(env);
  }
}

async function importRecipientList(env: Env, listId: string, expectedOffset: number): Promise<void> {
  const list = await env.DB.prepare(
    "SELECT id, object_key, status, import_offset, import_state_json FROM recipient_lists WHERE id = ?1",
  ).bind(listId).first<ImportRow>();
  if (!list || list.status !== "PROCESSING" || list.import_offset !== expectedOffset) return;
  const head = await env.CONTENT.head(list.object_key);
  if (!head) throw new Error(`Recipient list object is missing: ${list.object_key}`);
  const chunkBytes = positiveInt(env.IMPORT_CHUNK_BYTES, 512 * 1024, 2 * 1024 * 1024);
  const length = Math.min(chunkBytes, head.size - expectedOffset);
  if (length <= 0) return finishImport(env, listId);
  const object = await env.CONTENT.get(list.object_key, { range: { offset: expectedOffset, length } });
  if (!object) throw new Error(`Could not read recipient list object: ${list.object_key}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const isFinal = expectedOffset + bytes.length >= head.size;
  let previous: CsvParserState;
  try { previous = JSON.parse(list.import_state_json) as CsvParserState; }
  catch { previous = initialCsvState(); }
  if (!previous.row) previous = initialCsvState();
  const parsed = parseCsvChunk(bytes, previous, isFinal);
  const recipients = rowsToRecipients(parsed.rows, parsed.state);
  const now = nowIso();
  const insertStatements = recipients.map((recipient) => env.DB.prepare(
    `INSERT OR IGNORE INTO recipients
      (list_id, email, first_name, last_name, topics_json, data_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(listId, recipient.email, recipient.firstName, recipient.lastName,
    JSON.stringify(recipient.topics), JSON.stringify(recipient.data), now));
  for (let offset = 0; offset < insertStatements.length; offset += 75) {
    await env.DB.batch(insertStatements.slice(offset, offset + 75));
  }
  const nextOffset = expectedOffset + bytes.length;
  await env.DB.prepare(
    `UPDATE recipient_lists SET import_offset = ?2, import_state_json = ?3, updated_at = ?4
      WHERE id = ?1 AND import_offset = ?5 AND status = 'PROCESSING'`,
  ).bind(listId, nextOffset, JSON.stringify(parsed.state), now, expectedOffset).run();
  if (isFinal) await finishImport(env, listId);
  else await env.CAMPAIGN_QUEUE.send({ type: "import-list", listId, expectedOffset: nextOffset });
}

async function finishImport(env: Env, listId: string): Promise<void> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM recipients WHERE list_id = ?1").bind(listId).first<{ count: number }>();
  const total = Number(count?.count ?? 0);
  await env.DB.prepare(
    `UPDATE recipient_lists SET status = ?2, recipient_count = ?3,
       error = CASE WHEN ?3 = 0 THEN 'No valid email addresses found' ELSE NULL END,
       updated_at = ?4 WHERE id = ?1 AND status = 'PROCESSING'`,
  ).bind(listId, total > 0 ? "READY" : "FAILED", total, nowIso()).run();
}

async function expandCampaign(env: Env, campaignId: string, expectedCursor: number): Promise<void> {
  const campaign = await env.DB.prepare(
    "SELECT id, list_id, topic, status, expansion_cursor, expansion_done, expires_at FROM campaigns WHERE id = ?1",
  ).bind(campaignId).first<CampaignRow>();
  if (!campaign || campaign.expansion_done || campaign.expansion_cursor !== expectedCursor || !["PREPARING", "RUNNING"].includes(campaign.status)) return;
  const pageSize = positiveInt(env.CAMPAIGN_PAGE_SIZE, 250, 500);
  const query = campaign.topic
    ? `SELECT r.id, r.email, r.first_name, r.last_name, r.topics_json, r.data_json
         FROM recipients r LEFT JOIN suppressions s ON s.email = r.email
        WHERE r.list_id = ?1 AND r.id > ?2 AND s.email IS NULL
          AND EXISTS (SELECT 1 FROM json_each(r.topics_json) WHERE value = ?3)
        ORDER BY r.id LIMIT ?4`
    : `SELECT r.id, r.email, r.first_name, r.last_name, r.topics_json, r.data_json
         FROM recipients r LEFT JOIN suppressions s ON s.email = r.email
        WHERE r.list_id = ?1 AND r.id > ?2 AND s.email IS NULL
        ORDER BY r.id LIMIT ?3`;
  const result = campaign.topic
    ? await env.DB.prepare(query).bind(campaign.list_id, expectedCursor, campaign.topic, pageSize).all<SourceRecipient>()
    : await env.DB.prepare(query).bind(campaign.list_id, expectedCursor, pageSize).all<SourceRecipient>();
  const recipients = result.results;
  if (recipients.length === 0) return finishExpansion(env, campaignId);

  const existingBatch = await env.DB.prepare(
    "SELECT id, sequence FROM campaign_batches WHERE campaign_id = ?1 AND first_recipient_id = ?2",
  ).bind(campaignId, recipients[0].id).first<{ id: string; sequence: number }>();
  const sequenceRow = existingBatch ? null : await env.DB.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM campaign_batches WHERE campaign_id = ?1",
  ).bind(campaignId).first<{ sequence: number }>();
  const sequence = existingBatch?.sequence ?? Number(sequenceRow?.sequence ?? 0) + 1;
  const batchId = existingBatch?.id ?? `${campaignId}:batch:${sequence}`;
  const now = nowIso();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO campaign_batches
      (id, campaign_id, sequence, first_recipient_id, last_recipient_id, recipient_count, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDING', ?7, ?7)`,
  ).bind(batchId, campaignId, sequence, recipients[0].id, recipients.at(-1)!.id, recipients.length, now).run();

  const statements: D1PreparedStatement[] = [];
  for (const recipient of recipients) {
    const campaignRecipientId = `${campaignId}:${recipient.id}`;
    const data = safeObject(recipient.data_json);
    Object.assign(data, {
      email: recipient.email,
      firstName: recipient.first_name,
      lastName: recipient.last_name,
      topics: safeArray(recipient.topics_json),
    });
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO campaign_recipients
          (id, campaign_id, batch_id, source_recipient_id, email, data_json, status, updated_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDING', ?7, ?8)`,
      ).bind(campaignRecipientId, campaignId, batchId, recipient.id, recipient.email, JSON.stringify(data), now, campaign.expires_at),
      env.DB.prepare(
        `INSERT OR IGNORE INTO delivery_outbox (id, campaign_recipient_id, state, created_at)
         VALUES (?1, ?2, 'PENDING', ?3)`,
      ).bind(`out:${campaignId}:${recipient.id}`, campaignRecipientId, now),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 75) await env.DB.batch(statements.slice(offset, offset + 75));
  const nextCursor = recipients.at(-1)!.id;
  await env.DB.prepare(
    `UPDATE campaigns SET expansion_cursor = ?2, status = 'RUNNING',
       started_at = COALESCE(started_at, ?3), updated_at = ?3
      WHERE id = ?1 AND expansion_cursor = ?4`,
  ).bind(campaignId, nextCursor, now, expectedCursor).run();
  await Promise.all([
    env.CAMPAIGN_QUEUE.send({ type: "flush-outbox" }),
    env.CAMPAIGN_QUEUE.send({ type: "expand-campaign", campaignId, expectedCursor: nextCursor }),
  ]);
}

async function finishExpansion(env: Env, campaignId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE campaigns SET expansion_done = 1,
       total_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ?1),
       pending_count = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ?1 AND status IN ('PENDING','SENDING')),
       status = 'RUNNING', started_at = COALESCE(started_at, ?2), updated_at = ?2
     WHERE id = ?1 AND expansion_done = 0`,
  ).bind(campaignId, now).run();
  await env.CAMPAIGN_QUEUE.send({ type: "flush-outbox" });
  await maybeCompleteCampaign(env, campaignId);
}

async function flushOutbox(env: Env): Promise<void> {
  const result = await env.DB.prepare(
    "SELECT id, campaign_recipient_id FROM delivery_outbox WHERE state = 'PENDING' ORDER BY created_at LIMIT 100",
  ).all<{ id: string; campaign_recipient_id: string }>();
  if (result.results.length === 0) return;
  await env.EMAIL_QUEUE.sendBatch(result.results.map((row) => ({
    body: { type: "send-recipient", campaignRecipientId: row.campaign_recipient_id },
  })));
  const now = nowIso();
  await env.DB.batch(result.results.map((row) => env.DB.prepare(
    "UPDATE delivery_outbox SET state = 'DISPATCHED', dispatched_at = ?2 WHERE id = ?1 AND state = 'PENDING'",
  ).bind(row.id, now)));
  if (result.results.length === 100) await env.CAMPAIGN_QUEUE.send({ type: "flush-outbox" });
}

async function processDeliveryEvent(env: Env, job: EventJob): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT id, request_id, event_type, payload_json, processing_status FROM webhook_events WHERE id = ?1",
  ).bind(job.eventId).first<{ id: string; request_id: string | null; event_type: string; payload_json: string; processing_status: string }>();
  if (!row || row.processing_status === "PROCESSED") return;
  const event = JSON.parse(row.payload_json) as MailChannelsEvent;
  const now = nowIso();
  if (row.request_id) {
    const recipient = await env.DB.prepare(
      "SELECT id, campaign_id, email FROM campaign_recipients WHERE mailchannels_request_id = ?1",
    ).bind(row.request_id).first<{ id: string; campaign_id: string; email: string }>();
    if (recipient) await applyCampaignEvent(env, recipient, event, row.id, now);
    else await env.DB.prepare(
      "UPDATE adhoc_sends SET status = ?2, updated_at = ?3 WHERE request_id = ?1",
    ).bind(row.request_id, event.event.toUpperCase(), now).run();
  }
  await env.DB.prepare(
    "UPDATE webhook_events SET processing_status = 'PROCESSED', processed_at = ?2 WHERE id = ?1",
  ).bind(row.id, now).run();
}

async function applyCampaignEvent(
  env: Env,
  recipient: { id: string; campaign_id: string; email: string },
  event: MailChannelsEvent,
  eventId: string,
  now: string,
): Promise<void> {
  const config: Record<string, { column?: string; status: string; counter?: string }> = {
    processed: { column: "processed_at", status: "PROCESSED", counter: "processed_count" },
    delivered: { column: "delivered_at", status: "DELIVERED", counter: "delivered_count" },
    "hard-bounced": { column: "bounced_at", status: "BOUNCED", counter: "bounced_count" },
    "soft-bounced": { status: "SOFT_BOUNCED" },
    dropped: { column: "failed_at", status: "DROPPED", counter: "failed_count" },
    complained: { column: "complained_at", status: "COMPLAINED", counter: "complained_count" },
    open: { column: "opened_at", status: "OPENED", counter: "opened_count" },
    click: { column: "clicked_at", status: "CLICKED", counter: "clicked_count" },
    unsubscribed: { column: "unsubscribed_at", status: "UNSUBSCRIBED", counter: "unsubscribed_count" },
  };
  const item = config[event.event];
  if (!item) return;
  let changed = 0;
  if (item.column) {
    const allowed = new Set(["processed_at", "delivered_at", "bounced_at", "failed_at", "complained_at", "opened_at", "clicked_at", "unsubscribed_at"]);
    if (!allowed.has(item.column)) throw new Error("Invalid event column");
    const result = await env.DB.prepare(
      `UPDATE campaign_recipients SET ${item.column} = COALESCE(${item.column}, ?2),
       status = ?3, last_event = ?4, smtp_id = COALESCE(?5, smtp_id),
       last_error = COALESCE(?6, last_error), updated_at = ?2
       WHERE id = ?1 AND ${item.column} IS NULL`,
    ).bind(recipient.id, now, item.status, event.event, event.smtp_id ?? null, event.reason ?? null).run();
    changed = result.meta.changes ?? 0;
  } else {
    await env.DB.prepare(
      `UPDATE campaign_recipients SET status = ?2, last_event = ?3,
       smtp_id = COALESCE(?4, smtp_id), last_error = COALESCE(?5, last_error), updated_at = ?6 WHERE id = ?1`,
    ).bind(recipient.id, item.status, event.event, event.smtp_id ?? null, event.reason ?? null, now).run();
  }
  if (changed && item.counter) {
    const allowedCounters = new Set(["processed_count", "delivered_count", "bounced_count", "failed_count", "complained_count", "opened_count", "clicked_count", "unsubscribed_count"]);
    if (!allowedCounters.has(item.counter)) throw new Error("Invalid campaign counter");
    await env.DB.prepare(`UPDATE campaigns SET ${item.counter} = ${item.counter} + 1, updated_at = ?2 WHERE id = ?1`)
      .bind(recipient.campaign_id, now).run();
  }
  if (["hard-bounced", "complained", "unsubscribed"].includes(event.event)) {
    const addresses = event.recipients?.length ? event.recipients : [recipient.email];
    await env.DB.batch(addresses.map((address) => env.DB.prepare(
      `INSERT INTO suppressions (email, reason, source_event_id, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, source_event_id = excluded.source_event_id`,
    ).bind(address.toLowerCase(), event.event, eventId, now)));
  }
}

export async function scheduledMaintenance(env: Env, cron: string): Promise<void> {
  await repair(env);
  if (cron === "17 3 * * *") {
    const days = positiveInt(env.TRACKING_RETENTION_DAYS, 400, 3650);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM campaign_recipients WHERE expires_at IS NOT NULL AND expires_at < ?1").bind(Math.floor(Date.now() / 1000)),
      env.DB.prepare("DELETE FROM webhook_events WHERE received_at < datetime('now', ?1)").bind(`-${days} days`),
      env.DB.prepare("DELETE FROM upload_tokens WHERE expires_at < ?1").bind(Math.floor(Date.now() / 1000) - 86400),
    ]);
  }
}

async function repair(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE campaign_recipients SET status = 'PENDING', updated_at = ?1
       WHERE status = 'SENDING' AND updated_at < datetime('now', '-10 minutes')`,
    ).bind(nowIso()),
    env.DB.prepare(
      `UPDATE delivery_outbox SET state = 'PENDING', dispatched_at = NULL
       WHERE campaign_recipient_id IN (SELECT id FROM campaign_recipients WHERE status = 'PENDING')`,
    ),
  ]);
  const [lists, campaigns] = await Promise.all([
    env.DB.prepare("SELECT id, import_offset FROM recipient_lists WHERE status = 'PROCESSING' LIMIT 25").all<{ id: string; import_offset: number }>(),
    env.DB.prepare("SELECT id, expansion_cursor FROM campaigns WHERE expansion_done = 0 AND status IN ('PREPARING','RUNNING') LIMIT 25").all<{ id: string; expansion_cursor: number }>(),
  ]);
  const jobs: MessageSendRequest<CampaignJob>[] = [
    ...lists.results.map((row) => ({ body: { type: "import-list" as const, listId: row.id, expectedOffset: row.import_offset } })),
    ...campaigns.results.map((row) => ({ body: { type: "expand-campaign" as const, campaignId: row.id, expectedCursor: row.expansion_cursor } })),
    { body: { type: "flush-outbox" } },
  ];
  await env.CAMPAIGN_QUEUE.sendBatch(jobs);
}

function safeObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function safeArray(value: string): unknown[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
