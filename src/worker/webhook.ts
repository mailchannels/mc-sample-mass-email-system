import type { Env, EventJob, MailChannelsEvent } from "./types";
import { base64FromBytes, HttpError, json, nowIso } from "./utils";

const webhookKeyCache = new Map<string, { expires: number; key: CryptoKey }>();

export async function receiveWebhook(request: Request, env: Env): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (env.WEBHOOK_VERIFY_SIGNATURES !== "false") await verifySignature(body, request.headers);
  let events: MailChannelsEvent[];
  try {
    events = JSON.parse(new TextDecoder().decode(body)) as MailChannelsEvent[];
  } catch {
    throw new HttpError(400, "Webhook body must be JSON");
  }
  if (!Array.isArray(events) || events.length < 1 || events.length > 1000) {
    throw new HttpError(400, "Webhook body must contain 1-1000 events");
  }
  const now = nowIso();
  const jobs: MessageSendRequest<EventJob>[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const event of events) {
    if (!event.customer_handle || !event.event || !Number.isInteger(event.timestamp)) {
      throw new HttpError(400, "Webhook event is missing required fields");
    }
    if (env.MAILCHANNELS_CUSTOMER_HANDLE && event.customer_handle !== env.MAILCHANNELS_CUSTOMER_HANDLE) {
      throw new HttpError(403, "Webhook customer handle does not match this deployment");
    }
    const eventId = await eventFingerprint(event);
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO webhook_events
       (id, request_id, smtp_id, event_type, customer_handle, event_timestamp, recipients_json, payload_json, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(eventId, event.request_id ?? null, event.smtp_id ?? null, event.event, event.customer_handle,
      event.timestamp, JSON.stringify(event.recipients ?? []), JSON.stringify(event), now));
    jobs.push({ body: { type: "delivery-event", eventId } });
  }
  await env.DB.batch(statements);
  await env.EVENT_QUEUE.sendBatch(jobs);
  return json({ accepted: events.length }, { status: 202 });
}

export async function verifySignature(body: Uint8Array, headers: Headers): Promise<void> {
  const digestHeader = headers.get("content-digest");
  const signatureInput = headers.get("signature-input");
  const signatureHeader = headers.get("signature");
  if (!digestHeader || !signatureInput || !signatureHeader) {
    throw new HttpError(403, "Missing MailChannels webhook signature headers");
  }
  const digestMatch = digestHeader.match(/^sha-256=:([^:]+):$/i);
  if (!digestMatch) throw new HttpError(403, "Unsupported webhook content digest");
  const actualDigest = base64FromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(body))));
  if (!timingSafeEqual(actualDigest, digestMatch[1])) throw new HttpError(403, "Webhook content digest mismatch");

  const inputMatch = signatureInput.match(/^([A-Za-z0-9_-]+)=((?:\([^)]*\))(?:;[^,]+)*)$/);
  if (!inputMatch) throw new HttpError(403, "Invalid Signature-Input header");
  const [, signatureName, parameters] = inputMatch;
  const created = Number(parameters.match(/;created=(\d+)/)?.[1]);
  const keyId = parameters.match(/;keyid="([^"]+)"/)?.[1];
  const algorithm = parameters.match(/;alg="([^"]+)"/)?.[1];
  if (!created || !keyId || algorithm !== "ed25519" || !parameters.startsWith('(\"content-digest\")')) {
    throw new HttpError(403, "Unsupported webhook signature parameters");
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - created) > 300) throw new HttpError(403, "Webhook signature is outside the replay window");
  const signaturePattern = new RegExp(`${escapeRegExp(signatureName)}=:([^:]+):`);
  const signature = signatureHeader.match(signaturePattern)?.[1];
  if (!signature) throw new HttpError(403, "Webhook signature value is missing");

  const signingString = `\"content-digest\": ${digestHeader}\n\"@signature-params\": ${parameters}`;
  const key = await webhookPublicKey(keyId);
  const valid = await crypto.subtle.verify("Ed25519", key, asArrayBuffer(base64Bytes(signature)), asArrayBuffer(new TextEncoder().encode(signingString)));
  if (!valid) throw new HttpError(403, "Invalid MailChannels webhook signature");
}

async function webhookPublicKey(keyId: string): Promise<CryptoKey> {
  const cached = webhookKeyCache.get(keyId);
  if (cached && cached.expires > Date.now()) return cached.key;
  const response = await fetch(`https://api.mailchannels.net/tx/v1/webhook/public-key?id=${encodeURIComponent(keyId)}`);
  if (!response.ok) throw new HttpError(503, "Could not retrieve MailChannels webhook public key");
  const payload = await response.json<{ id: string; key: string }>();
  const der = pemBytes(payload.key);
  const key = await crypto.subtle.importKey("spki", asArrayBuffer(der), "Ed25519", false, ["verify"]);
  webhookKeyCache.set(keyId, { expires: Date.now() + 60 * 60 * 1000, key });
  return key;
}

function pemBytes(pem: string): Uint8Array {
  const encoded = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  return base64Bytes(encoded);
}

function base64Bytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function eventFingerprint(event: MailChannelsEvent): Promise<string> {
  const canonical = JSON.stringify(sortValue(event));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", asArrayBuffer(new TextEncoder().encode(canonical))));
  return `evt_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}
