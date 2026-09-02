# Architecture and correctness notes

## Behavioral target

The AWS sample exposes six operator capabilities: authenticated UI access, SES-style template management, recipient CSV ingestion, individual sends, mass campaign orchestration, and per-recipient campaign monitoring. This project retains those capabilities while choosing primitives native to MailChannels and Cloudflare.

The implementation intentionally does not reproduce CloudFormation stacks, AWS identity concepts, SES template storage, a Step Functions state machine, or one DynamoDB table per campaign. D1 is relational, so shared indexed tables are the natural Cloudflare representation.

## Control flow

1. The browser obtains a short-lived upload ticket from the Worker and streams a CSV to an authenticated Worker route. The Worker streams it into R2.
2. A campaign-queue job reads bounded R2 byte ranges. Parser state and the byte offset live in D1, so jobs can retry or continue without rereading the whole file.
3. Launch creates an immutable campaign identity and computes the eligible audience after local suppression/topic filtering.
4. Campaign expander jobs page through the source list. For every recipient they insert a campaign ledger row and a delivery-outbox row. Unique `(campaign_id, source_recipient_id)` and deterministic outbox keys make retries idempotent.
5. The outbox flusher persists Email Queue messages before marking outbox rows dispatched. A crash between those steps may duplicate a queue message but cannot silently lose it.
6. An Email Queue consumer acquires a token from the global Durable Object, claims a `PENDING` recipient, assembles R2 attachments, and calls MailChannels `POST /tx/v1/send-async` with exactly one personalization.
7. The returned MailChannels `request_id` is written to the campaign recipient row. This is the join key for all later webhook events.
8. The public webhook route verifies the content digest, signature timestamp, Ed25519 signature, and `customer_handle`. It stores the raw payload before acknowledging with `202`, then queues each event for state projection.
9. Event consumers update timestamp flags and aggregate campaign counters idempotently. Hard bounces, complaints, and unsubscribes also enter the local suppression mirror.
10. Cron repairs incomplete imports/expansions, republishes pending outbox work, re-leases stale sends, and applies retention.

## Key invariants

- A source recipient occurs at most once in a campaign: `UNIQUE(campaign_id, source_recipient_id)`.
- An Email API request maps to at most one campaign recipient: unique `mailchannels_request_id`.
- A webhook payload is stored before downstream processing.
- Counters increment only when the corresponding recipient timestamp changes from `NULL`.
- An outbox record is durable before a Queue message can exist.
- The MailChannels API key never reaches the browser, D1, R2, logs, or configuration committed to Git.
- Campaign summaries are not deleted when granular tracking reaches its retention date.

## State models

Campaign: `PREPARING → RUNNING → COMPLETED | COMPLETED_WITH_ERRORS`.

Recipient send path: `PENDING → SENDING → ACCEPTED | FAILED`. Delivery events can then project `PROCESSED`, `DELIVERED`, `BOUNCED`, `COMPLAINED`, `OPENED`, `CLICKED`, `UNSUBSCRIBED`, or `DROPPED`. Timestamp columns retain prior milestones when status advances.

A campaign is send-complete once expansion is finished and every recipient is either accepted by MailChannels or has a permanent API failure. Delivery and engagement events continue to update after completion, matching the AWS sample's separation between send progress and downstream outcomes.

## Scaling boundaries

- CSV ingestion is chunked and does not hold the full file in Worker memory.
- Campaign expansion is paginated and resumable.
- Queue payloads contain identifiers, not message bodies or personal data beyond opaque IDs.
- Attachments are loaded only by the sending Worker. This sample caps raw attachments at 20 MB so base64 encoding remains below MailChannels' 30 MB total-message limit and leaves Worker memory headroom.
- A single D1 database is appropriate for the sample. Very large or multi-tenant production systems may shard by tenant, move analytical events to R2, or use Cloudflare Pipelines/Analytics Engine.

## Failure modes

| Failure | Behavior |
|---|---|
| CSV job retry | Reprocesses its byte range; `INSERT OR IGNORE` prevents duplicate recipients. |
| Expansion job retry | Deterministic ledger/outbox keys prevent duplicates. |
| Crash after queue send, before outbox update | Queue message may duplicate; recipient claim allows one active send. |
| MailChannels 429/5xx | Recipient returns to `PENDING`; Queue retry uses `Retry-After` or bounded delay. |
| MailChannels 4xx | Recipient becomes `FAILED`; the campaign can complete with errors. |
| Crash after Email API accepts, before D1 update | Ambiguous send; retry can duplicate. This cannot be eliminated without provider idempotency. |
| Duplicate webhook | Event milestone columns prevent duplicate aggregate increments. Raw duplicate retention is acceptable for audit. |
| Event projection failure | Event Queue retries and then DLQs; raw event remains `RECEIVED` for replay. |
| Queue/database drift | One-minute repair sweep republishes stored offsets, cursors, and pending outbox work. |

## Security posture

Cloudflare Access JWTs are verified by the Worker, including signature, expiry, audience, and optional operator domain. This matters even when Access is configured at the edge because it avoids trusting a user-controlled identity header.

The webhook is intentionally outside Access. Its independent trust boundary is MailChannels' RFC 9421-style signed request plus an exact account-handle match. Raw bodies are hashed and verified before JSON processing.

Deploy Cloudflare WAF rate-limit rules for operator APIs and the webhook, keep preview/development authentication off in production, scan user-supplied attachments for malware, and use separate MailChannels sub-accounts if tenants need reputation and quota isolation.
