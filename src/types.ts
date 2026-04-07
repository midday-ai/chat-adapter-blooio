export interface BlooioAdapterConfig {
  apiKey: string;
  /**
   * Override the Blooio API base URL.
   * @default "https://backend.blooio.com/v2/api"
   */
  baseUrl?: string;
  /**
   * Default sending number for multi-number accounts (E.164 format).
   * Sent as `X-From-Number` header on outbound requests.
   */
  defaultFromNumber?: string;
  /**
   * Webhook signing secret for HMAC-SHA256 verification.
   */
  webhookSecret?: string;
  /**
   * Maximum age (in seconds) for webhook timestamps before they are rejected.
   * @default 300
   */
  timestampToleranceSec?: number;
  /**
   * Which messaging protocols to accept from inbound webhooks.
   * If empty or undefined, all protocols are accepted.
   */
  allowedProtocols?: BlooioProtocol[];
}

export type BlooioProtocol = "imessage" | "sms" | "rcs" | "non-imessage";

export interface BlooioThreadId {
  internalId: string;
  chatId?: string;
  groupId?: string;
}

// ---------------------------------------------------------------------------
// Webhook payload shapes
// ---------------------------------------------------------------------------

export type BlooioWebhookEvent =
  | "message.received"
  | "message.sent"
  | "message.delivered"
  | "message.failed"
  | "message.read"
  | "message.reaction";

export interface BlooioWebhookParticipant {
  contact_id: string;
  identifier: string;
  name: string | null;
}

export interface BlooioMessagePayload {
  event: BlooioWebhookEvent;
  message_id: string;
  external_id: string;
  text: string;
  attachments: string[];
  protocol: BlooioProtocol;
  timestamp: number;
  internal_id: string;
  received_at?: number;
  sent_at?: number;
  delivered_at?: number;
  read_at?: number;
  sender: string;
  is_group: boolean;
  group_id: string | null;
  group_name: string | null;
  participants: BlooioWebhookParticipant[] | null;
  error_code?: string;
  error_message?: string;
}

export interface BlooioReactionPayload {
  event: "message.reaction";
  direction: "inbound" | "outbound";
  message_id: string;
  external_id: string;
  reaction: BlooioReaction;
  action: "add" | "remove";
  sender: string;
  original_text: string;
  timestamp: number;
  internal_id: string;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export type BlooioReaction =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

export const VALID_REACTIONS: ReadonlySet<string> = new Set<BlooioReaction>([
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
]);

export const REACTION_ALIASES: Record<string, BlooioReaction> = {
  heart: "love",
  thumbs_up: "like",
  thumbsup: "like",
  "+1": "like",
  thumbs_down: "dislike",
  thumbsdown: "dislike",
  "-1": "dislike",
  haha: "laugh",
  exclamation: "emphasize",
  "!!": "emphasize",
  "?": "question",
};

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

export interface BlooioSendMessageBody {
  text?: string;
  attachments?: (string | { url: string; name?: string })[];
  metadata?: Record<string, unknown>;
  use_typing_indicator?: boolean;
  from_number?: string;
}

export interface BlooioSendMessageResponse {
  message_id: string;
  message_ids?: string[];
  status: string;
  group_id?: string;
  group_created?: boolean;
  participants?: string[];
}

export interface BlooioMessageDetail {
  message_id: string;
  chat_id: string;
  direction: "inbound" | "outbound";
  internal_id: string;
  contact?: {
    contact_id: string;
    name: string | null;
    identifier: string;
  };
  sender: string;
  text: string;
  attachments: unknown[];
  reactions: {
    reaction: string;
    is_added: boolean;
    time_sent: number;
    sender: string;
  }[];
  time_sent: number;
  time_delivered: number | null;
  status: string;
  protocol: BlooioProtocol;
  error: string | null;
}

export interface BlooioListMessagesParams {
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
  direction?: "inbound" | "outbound";
  since?: number;
  until?: number;
}

export interface BlooioListMessagesResponse {
  chat_id: string;
  messages: BlooioMessageDetail[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface BlooioReactionResponse {
  success: boolean;
  message_id: string;
  reaction: string;
  action: "add" | "remove";
}

export interface BlooioCapabilitiesResponse {
  contact: string;
  type: "phone" | "email";
  capabilities: {
    imessage: boolean;
    sms: boolean;
  };
  lastChecked: string;
}

export interface BlooioMeResponse {
  auth_type: string;
  valid: boolean;
  user_id: string;
  api_key: string;
  organization_id: string;
  organization: {
    organization_id: string;
    name: string;
    country_code: string;
    created_at: number;
  };
  devices: {
    phone_number: string;
    is_active: boolean;
    last_active: number | null;
  }[];
  usage: {
    inbound_messages: number;
    outbound_messages: number;
    last_message_sent: number | null;
  };
}

export interface BlooioErrorResponse {
  error: string;
  message?: string;
  status: number;
}
