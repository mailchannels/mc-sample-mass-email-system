export interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  CAMPAIGN_QUEUE: Queue<CampaignJob>;
  EMAIL_QUEUE: Queue<EmailJob>;
  EVENT_QUEUE: Queue<EventJob>;
  RATE_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  MAILCHANNELS_API_KEY: string;
  MAILCHANNELS_CUSTOMER_HANDLE: string;
  AUTH_MODE: "development" | "cloudflare-access";
  ALLOWED_EMAIL_DOMAIN?: string;
  ALLOWED_SENDER_DOMAINS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  WEBHOOK_VERIFY_SIGNATURES?: string;
  TRACKING_RETENTION_DAYS?: string;
  IMPORT_CHUNK_BYTES?: string;
  CAMPAIGN_PAGE_SIZE?: string;
  EMAIL_RATE_LIMIT?: string;
}

export type CampaignJob =
  | { type: "import-list"; listId: string; expectedOffset: number }
  | { type: "expand-campaign"; campaignId: string; expectedCursor: number }
  | { type: "flush-outbox" }
  | { type: "repair" };

export interface EmailJob {
  type: "send-recipient";
  campaignRecipientId: string;
}

export interface EventJob {
  type: "delivery-event";
  eventId: string;
}

export interface MailChannelsEvent {
  email?: string;
  customer_handle: string;
  timestamp: number;
  event: string;
  request_id?: string;
  smtp_id?: string;
  campaign_id?: string;
  recipients?: string[];
  status?: string;
  reason?: string;
  url?: string;
  user_agent?: string;
  ip?: string;
}

export interface CsvParserState {
  headers?: string[];
  row: string[];
  fieldBase64: string;
  inQuotes: boolean;
  quotePending: boolean;
  sawCarriageReturn: boolean;
  firstRow: boolean;
}

export interface RecipientInput {
  email: string;
  firstName: string;
  lastName: string;
  topics: string[];
  data: Record<string, string>;
}
