PRAGMA foreign_keys = ON;

CREATE TABLE templates (
  name TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipient_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('UPLOADING','PROCESSING','READY','FAILED')),
  recipient_count INTEGER NOT NULL DEFAULT 0,
  import_offset INTEGER NOT NULL DEFAULT 0,
  import_state_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id TEXT NOT NULL REFERENCES recipient_lists(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  topics_json TEXT NOT NULL DEFAULT '[]',
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(list_id, email)
);
CREATE INDEX recipients_list_cursor ON recipients(list_id, id);
CREATE INDEX recipients_email ON recipients(email);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE upload_tokens (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('recipient-list','attachment')),
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  list_id TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX upload_tokens_expiry ON upload_tokens(expires_at);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT,
  list_id TEXT NOT NULL REFERENCES recipient_lists(id),
  list_name TEXT NOT NULL,
  template_name TEXT NOT NULL REFERENCES templates(name),
  sender_email TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  reply_to TEXT,
  topic TEXT,
  transactional INTEGER NOT NULL DEFAULT 0,
  enable_tracking INTEGER NOT NULL DEFAULT 0,
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('PREPARING','RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED','CANCELLED')),
  expansion_cursor INTEGER NOT NULL DEFAULT 0,
  expansion_done INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  bounced_count INTEGER NOT NULL DEFAULT 0,
  complained_count INTEGER NOT NULL DEFAULT 0,
  opened_count INTEGER NOT NULL DEFAULT 0,
  clicked_count INTEGER NOT NULL DEFAULT 0,
  unsubscribed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX campaigns_created ON campaigns(created_at DESC);

CREATE TABLE campaign_batches (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  first_recipient_id INTEGER NOT NULL,
  last_recipient_id INTEGER NOT NULL,
  recipient_count INTEGER NOT NULL,
  queued_count INTEGER NOT NULL DEFAULT 0,
  terminal_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, sequence)
);
CREATE INDEX campaign_batches_campaign ON campaign_batches(campaign_id, sequence);

CREATE TABLE campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES campaign_batches(id) ON DELETE CASCADE,
  source_recipient_id INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  data_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  mailchannels_request_id TEXT UNIQUE,
  smtp_id TEXT,
  last_event TEXT,
  last_error TEXT,
  accepted_at TEXT,
  processed_at TEXT,
  delivered_at TEXT,
  bounced_at TEXT,
  complained_at TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  unsubscribed_at TEXT,
  failed_at TEXT,
  updated_at TEXT NOT NULL,
  expires_at INTEGER,
  UNIQUE(campaign_id, source_recipient_id)
);
CREATE INDEX campaign_recipients_campaign_status ON campaign_recipients(campaign_id, status, id);
CREATE INDEX campaign_recipients_campaign_email ON campaign_recipients(campaign_id, email);
CREATE INDEX campaign_recipients_request ON campaign_recipients(mailchannels_request_id);

CREATE TABLE delivery_outbox (
  id TEXT PRIMARY KEY,
  campaign_recipient_id TEXT NOT NULL REFERENCES campaign_recipients(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','DISPATCHED')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT
);
CREATE INDEX delivery_outbox_pending ON delivery_outbox(state, created_at);

CREATE TABLE adhoc_sends (
  id TEXT PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  template_name TEXT,
  request_id TEXT UNIQUE,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  smtp_id TEXT,
  event_type TEXT NOT NULL,
  customer_handle TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED',
  received_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX webhook_events_request ON webhook_events(request_id, event_timestamp);

CREATE TABLE suppressions (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL,
  source_event_id TEXT,
  created_at TEXT NOT NULL
);
