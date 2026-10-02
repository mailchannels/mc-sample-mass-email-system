export interface Env {
  DB: D1Database;
  ACCOUNTS: DurableObjectNamespace;
  PLATFORM_HOST?: string;
  BOOTSTRAP_OWNER_EMAIL?: string;
  SESSION_SECRET?: string;
  KEY_ENCRYPTION_SECRET?: string;
  LOCAL_TEST?: string;
  LOCAL_PORT?: string;
  PROVIDER?: Fetcher;
  SYSTEM_EMAIL_FROM?: string;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  CONTENT: R2Bucket;
  CAMPAIGN_QUEUE: Queue<CampaignJob>;
  EMAIL_QUEUE: Queue<EmailJob>;
  EVENT_QUEUE: Queue<EventJob>;
  RATE_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
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

export type CampaignJob = { accountId: string } & (
  | { type: "import-list"; listId: string; expectedOffset: number }
  | { type: "expand-campaign"; campaignId: string; expectedCursor: number }
  | { type: "flush-outbox" }
  | { type: "repair" }
);

export interface EmailJob {
  accountId: string;
  type: "send-recipient";
  campaignRecipientId: string;
}

export interface EventJob {
  accountId: string;
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

export interface TenantContext extends Omit<Env, "DB" | "ACCOUNTS"> {
  MAILCHANNELS_API_KEY: string;
  MAILCHANNELS_CUSTOMER_HANDLE: string;
  accountId: string;
  resellerId: string;
  postalAddress: string;
  publicHost: string;
  trackingDomains: Record<string, string>;
  sendRate: number;
  resellerRate: number;
  monthlyLimit: number;
  contactLimit: number;
  accountStatus: string;
  verifiedTestEmails: string[];
  STORE: import("./account/sql").AccountStore;
}
export interface AccountRecord {
  id: string;
  reseller_id: string;
  name: string;
  status: string;
  mc_handle: string | null;
  mc_key_ref: string | null;
  jurisdiction: string;
}
