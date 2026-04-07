import type {
  BlooioCapabilitiesResponse,
  BlooioErrorResponse,
  BlooioListMessagesParams,
  BlooioListMessagesResponse,
  BlooioMeResponse,
  BlooioReactionResponse,
  BlooioSendMessageBody,
  BlooioSendMessageResponse,
} from "./types";

const DEFAULT_BASE_URL = "https://backend.blooio.com/v2/api";

export class BlooioApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "BlooioApiError";
  }
}

function encodeChatId(chatId: string): string {
  return encodeURIComponent(chatId);
}

export class BlooioClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultFromNumber?: string;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    defaultFromNumber?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.defaultFromNumber = opts.defaultFromNumber;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async sendMessage(
    chatId: string,
    body: BlooioSendMessageBody,
  ): Promise<BlooioSendMessageResponse> {
    const payload = { ...body };
    if (!payload.from_number && this.defaultFromNumber) {
      payload.from_number = this.defaultFromNumber;
    }
    return this.request<BlooioSendMessageResponse>(
      "POST",
      `/chats/${encodeChatId(chatId)}/messages`,
      payload,
    );
  }

  async listMessages(
    chatId: string,
    params?: BlooioListMessagesParams,
  ): Promise<BlooioListMessagesResponse> {
    const query: Record<string, string> = {};
    if (params?.limit != null) query.limit = String(params.limit);
    if (params?.offset != null) query.offset = String(params.offset);
    if (params?.sort) query.sort = params.sort;
    if (params?.direction) query.direction = params.direction;
    if (params?.since != null) query.since = String(params.since);
    if (params?.until != null) query.until = String(params.until);

    return this.request<BlooioListMessagesResponse>(
      "GET",
      `/chats/${encodeChatId(chatId)}/messages`,
      undefined,
      query,
    );
  }

  async getMessageStatus(
    chatId: string,
    messageId: string,
  ): Promise<{ message_id: string; status: string; protocol?: string }> {
    return this.request(
      "GET",
      `/chats/${encodeChatId(chatId)}/messages/${encodeURIComponent(messageId)}/status`,
    );
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  async addReaction(
    chatId: string,
    messageId: string,
    reaction: string,
  ): Promise<BlooioReactionResponse> {
    return this.request<BlooioReactionResponse>(
      "POST",
      `/chats/${encodeChatId(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { reaction },
    );
  }

  // -------------------------------------------------------------------------
  // Typing & Read
  // -------------------------------------------------------------------------

  async startTyping(chatId: string): Promise<void> {
    await this.request("POST", `/chats/${encodeChatId(chatId)}/typing`);
  }

  async stopTyping(chatId: string): Promise<void> {
    await this.request("DELETE", `/chats/${encodeChatId(chatId)}/typing`);
  }

  async markRead(chatId: string): Promise<void> {
    await this.request("POST", `/chats/${encodeChatId(chatId)}/read`);
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  async checkCapabilities(
    contact: string,
  ): Promise<BlooioCapabilitiesResponse> {
    return this.request<BlooioCapabilitiesResponse>(
      "GET",
      `/contacts/${encodeURIComponent(contact)}/capabilities`,
    );
  }

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  async getMe(): Promise<BlooioMeResponse> {
    return this.request<BlooioMeResponse>("GET", "/me");
  }

  // -------------------------------------------------------------------------
  // Generic request
  // -------------------------------------------------------------------------

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams(query).toString();
      url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      let errBody: BlooioErrorResponse | undefined;
      try {
        errBody = (await res.json()) as BlooioErrorResponse;
      } catch {
        // response was not JSON
      }
      throw new BlooioApiError(
        res.status,
        errBody?.error ?? `HTTP_${res.status}`,
        errBody?.message ?? errBody?.error ?? res.statusText,
      );
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return (await res.json()) as T;
  }
}
