import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, parseMarkdown, stringifyMarkdown } from "chat";
import { createHmac, timingSafeEqual } from "node:crypto";
import { BlooioClient } from "./client";
import { toPlainText } from "./format-converter";
import type {
  BlooioAdapterConfig,
  BlooioMessagePayload,
  BlooioReaction,
  BlooioReactionPayload,
  BlooioThreadId,
} from "./types";
import { REACTION_ALIASES, VALID_REACTIONS } from "./types";

const DEFAULT_TIMESTAMP_TOLERANCE_SEC = 300;

export class BlooioAdapter
  implements Adapter<BlooioThreadId, BlooioMessagePayload>
{
  readonly name = "blooio";
  readonly persistMessageHistory = true;
  readonly userName: string;

  private chat: ChatInstance | null = null;
  private logger: Logger;
  private config: BlooioAdapterConfig;
  private client: BlooioClient;

  constructor(
    config: BlooioAdapterConfig & { logger?: Logger; client?: BlooioClient },
  ) {
    this.config = config;
    this.userName = "midday";
    this.logger = config.logger ?? new ConsoleLogger();
    this.client =
      config.client ??
      new BlooioClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultFromNumber: config.defaultFromNumber,
      });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger("blooio");
    this.logger.info("Blooio adapter initialized");
  }

  async disconnect(): Promise<void> {
    this.logger.info("Blooio adapter disconnected");
  }

  // ---------------------------------------------------------------------------
  // Thread ID encode / decode
  // ---------------------------------------------------------------------------

  encodeThreadId(data: BlooioThreadId): string {
    const internal = Buffer.from(data.internalId).toString("base64url");
    if (data.groupId) {
      const group = Buffer.from(data.groupId).toString("base64url");
      return `blooio:${internal}:g:${group}`;
    }
    const chat = Buffer.from(data.chatId ?? "").toString("base64url");
    return `blooio:${internal}:${chat}`;
  }

  decodeThreadId(threadId: string): BlooioThreadId {
    const parts = threadId.split(":");
    if (parts.length < 3 || parts[0] !== "blooio") {
      throw new Error(`Invalid Blooio thread ID: ${threadId}`);
    }

    const internalId = Buffer.from(parts[1]!, "base64url").toString();

    if (parts[2] === "g" && parts[3]) {
      return {
        internalId,
        groupId: Buffer.from(parts[3], "base64url").toString(),
      };
    }

    return {
      internalId,
      chatId: Buffer.from(parts[2]!, "base64url").toString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Webhook handling
  // ---------------------------------------------------------------------------

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    const rawBody = await request.text();

    if (this.config.webhookSecret) {
      const signatureHeader = request.headers.get("x-blooio-signature");
      if (!signatureHeader) {
        this.logger.warn("Blooio webhook missing signature header");
        return new Response("Unauthorized", { status: 401 });
      }

      if (!this.verifySignature(this.config.webhookSecret, signatureHeader, rawBody)) {
        this.logger.warn("Blooio webhook signature mismatch");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const event = request.headers.get("x-blooio-event") ?? (body.event as string | undefined);

    if (!event) {
      this.logger.debug("Blooio webhook ignored (no event type)", {
        keys: Object.keys(body),
      });
      return new Response("OK", { status: 200 });
    }

    if (event === "message.received") {
      const payload = body as unknown as BlooioMessagePayload;

      this.logger.info("Blooio webhook message received", {
        message_id: payload.message_id,
        protocol: payload.protocol,
        hasText: !!payload.text,
        hasAttachments: (payload.attachments?.length ?? 0) > 0,
        is_group: payload.is_group,
      });

      if (!this.isProtocolAllowed(payload.protocol)) {
        this.logger.debug("Blooio webhook filtered by protocol", {
          protocol: payload.protocol,
        });
        return new Response("OK", { status: 200 });
      }

      await this.processInboundMessage(payload, options);
      return new Response("OK", { status: 200 });
    }

    if (event === "message.reaction") {
      const payload = body as unknown as BlooioReactionPayload;
      this.logger.debug("Blooio reaction received", {
        reaction: payload.reaction,
        action: payload.action,
        sender: payload.sender,
      });
      return new Response("OK", { status: 200 });
    }

    this.logger.debug("Blooio webhook event acknowledged", { event });
    return new Response("OK", { status: 200 });
  }

  private verifySignature(
    secret: string,
    signatureHeader: string,
    rawBody: string,
  ): boolean {
    const parts = signatureHeader.split(",");
    let timestamp: string | undefined;
    let signature: string | undefined;

    for (const part of parts) {
      const [key, value] = part.split("=");
      if (key === "t") timestamp = value;
      if (key === "v1") signature = value;
    }

    if (!timestamp || !signature) return false;

    const toleranceSec =
      this.config.timestampToleranceSec ?? DEFAULT_TIMESTAMP_TOLERANCE_SEC;
    const webhookAge = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (webhookAge > toleranceSec) {
      this.logger.warn("Blooio webhook timestamp too old", {
        age: webhookAge,
        tolerance: toleranceSec,
      });
      return false;
    }

    const payload = `${timestamp}.${rawBody}`;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");

    try {
      return timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(signature, "hex"),
      );
    } catch {
      return false;
    }
  }

  private async processInboundMessage(
    payload: BlooioMessagePayload,
    options?: WebhookOptions,
  ): Promise<void> {
    if (!this.chat) return;

    const threadId = this.threadIdFromPayload(payload);

    this.markRead(threadId).catch(() => {});

    const factory = async (): Promise<Message<BlooioMessagePayload>> => {
      return this.parseMessage(payload);
    };

    this.chat.processMessage(this, threadId, factory, options);
  }

  // ---------------------------------------------------------------------------
  // Message parsing
  // ---------------------------------------------------------------------------

  parseMessage(raw: BlooioMessagePayload): Message<BlooioMessagePayload> {
    const threadId = this.threadIdFromPayload(raw);
    const text = raw.text ?? "";
    const isOutbound = raw.event === "message.sent";

    const attachments: Attachment[] = [];
    if (raw.attachments && raw.attachments.length > 0) {
      for (const url of raw.attachments) {
        if (typeof url === "string" && url.length > 0) {
          attachments.push(this.buildAttachment(url));
        }
      }
    }

    return new Message({
      id: raw.message_id,
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw,
      author: {
        userId: isOutbound ? (raw.internal_id ?? "bot") : raw.sender,
        userName: isOutbound ? (raw.internal_id ?? "bot") : raw.sender,
        fullName: "",
        isBot: isOutbound,
        isMe: isOutbound,
      },
      metadata: {
        dateSent: new Date(raw.received_at ?? raw.timestamp),
        edited: false,
      },
      isMention: !isOutbound,
      attachments,
    });
  }

  // ---------------------------------------------------------------------------
  // Sending messages
  // ---------------------------------------------------------------------------

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<BlooioMessagePayload>> {
    const decoded = this.decodeThreadId(threadId);
    const text = this.renderOutbound(message);
    const chatId = decoded.groupId ?? decoded.chatId!;

    if (!text?.trim()) {
      this.logger.debug("Skipping empty outbound message");
      return {
        raw: {} as BlooioMessagePayload,
        id: "",
        threadId,
      };
    }

    const response = await this.client.sendMessage(chatId, { text });

    return {
      raw: response as unknown as BlooioMessagePayload,
      id: response.message_id ?? "",
      threadId,
    };
  }

  async sendMediaMessage(
    threadId: string,
    mediaUrl: string,
    content?: string,
  ): Promise<void> {
    const decoded = this.decodeThreadId(threadId);
    const chatId = decoded.groupId ?? decoded.chatId!;

    await this.client.sendMessage(chatId, {
      text: content ?? "",
      attachments: [mediaUrl],
    });
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<BlooioMessagePayload>> {
    let lastResult: RawMessage<BlooioMessagePayload> | undefined;
    let current = "";

    for await (const chunk of textStream) {
      let text = "";
      if (typeof chunk === "string") {
        text = chunk;
      } else if (chunk.type === "markdown_text") {
        text = chunk.text;
      }
      if (!text) continue;

      current += text;

      const parts = current.split("\n\n");
      if (parts.length > 1) {
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i]!.trim();
          if (seg) {
            lastResult = await this.postMessage(threadId, { markdown: seg });
          }
        }
        current = parts[parts.length - 1]!;
      }
    }

    if (current.trim()) {
      lastResult = await this.postMessage(threadId, {
        markdown: current.trim(),
      });
    }

    if (!lastResult) {
      this.logger.debug("Stream produced no content, skipping send");
      return { raw: {} as BlooioMessagePayload, id: "", threadId };
    }

    return lastResult;
  }

  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<BlooioMessagePayload>> {
    throw new Error(
      "Blooio does not support message editing. iMessage messages cannot be edited via API.",
    );
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    this.logger.warn(
      "Blooio deleteMessage is a no-op — iMessage messages cannot be unsent via API",
    );
  }

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    const decoded = this.decodeThreadId(threadId);
    const chatId = decoded.groupId ?? decoded.chatId!;
    const emojiName = typeof emoji === "string" ? emoji : emoji.name;
    const reaction = this.resolveReaction(emojiName);

    if (!reaction) {
      this.logger.warn("Unsupported Blooio reaction, ignoring", {
        emoji: emojiName,
      });
      return;
    }

    await this.client.addReaction(chatId, messageId, `+${reaction}`);
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    const decoded = this.decodeThreadId(threadId);
    const chatId = decoded.groupId ?? decoded.chatId!;
    const emojiName = typeof emoji === "string" ? emoji : emoji.name;
    const reaction = this.resolveReaction(emojiName);

    if (!reaction) {
      this.logger.warn("Unsupported Blooio reaction for removal, ignoring", {
        emoji: emojiName,
      });
      return;
    }

    await this.client.addReaction(chatId, messageId, `-${reaction}`);
  }

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<BlooioMessagePayload>> {
    const decoded = this.decodeThreadId(threadId);
    const chatId = decoded.groupId ?? decoded.chatId!;
    const limit = options?.limit ?? 20;
    const offset =
      options?.cursor != null ? Number.parseInt(options.cursor, 10) : 0;

    const result = await this.client.listMessages(chatId, {
      limit,
      offset,
      sort: "desc",
    });

    const messages = (result.messages ?? [])
      .map((raw) => {
        const asPayload: BlooioMessagePayload = {
          event:
            raw.direction === "inbound" ? "message.received" : "message.sent",
          message_id: raw.message_id,
          external_id: raw.contact?.identifier ?? raw.sender ?? "",
          text: raw.text ?? "",
          attachments: (raw.attachments ?? []).map((a) =>
            typeof a === "string" ? a : (a as { url?: string }).url ?? "",
          ),
          protocol: raw.protocol,
          timestamp: raw.time_sent,
          internal_id: raw.internal_id,
          sender: raw.sender,
          is_group: !!decoded.groupId,
          group_id: decoded.groupId ?? null,
          group_name: null,
          participants: null,
        };
        return this.parseMessage(asPayload);
      })
      .reverse();

    const total = result.pagination?.total ?? 0;
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < total ? String(nextOffset) : undefined;

    return { messages, nextCursor };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const decoded = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      isDM: !decoded.groupId,
      metadata: {
        internalId: decoded.internalId,
        chatId: decoded.chatId,
        groupId: decoded.groupId,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Typing
  // ---------------------------------------------------------------------------

  async startTyping(threadId: string): Promise<void> {
    const decoded = this.decodeThreadId(threadId);
    const chatId = decoded.groupId ?? decoded.chatId!;

    try {
      await this.client.startTyping(chatId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug("Blooio typing indicator failed", { error: message });
    }
  }

  // ---------------------------------------------------------------------------
  // Blooio-specific helpers (not part of Adapter interface)
  // ---------------------------------------------------------------------------

  async markRead(threadId: string): Promise<void> {
    const decoded = this.decodeThreadId(threadId);
    const chatId = decoded.groupId ?? decoded.chatId!;
    await this.client.markRead(chatId);
  }

  async checkCapabilities(
    contact: string,
  ): Promise<{ contact: string; capabilities: { imessage: boolean; sms: boolean } }> {
    return this.client.checkCapabilities(contact);
  }

  /** Direct access to the Blooio API client */
  getClient(): BlooioClient {
    return this.client;
  }

  // ---------------------------------------------------------------------------
  // Channel ID
  // ---------------------------------------------------------------------------

  channelIdFromThreadId(threadId: string): string {
    const parts = threadId.split(":");
    return `${parts[0]}:${parts[1]}`;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  renderFormatted(content: FormattedContent): string {
    return toPlainText(stringifyMarkdown(content));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private renderOutbound(message: AdapterPostableMessage): string {
    if (typeof message === "string") return toPlainText(message);
    if ("markdown" in message && typeof message.markdown === "string") {
      return toPlainText(message.markdown);
    }
    if ("text" in message && typeof message.text === "string") {
      return toPlainText(message.text);
    }
    if ("ast" in message && message.ast) {
      return toPlainText(stringifyMarkdown(message.ast));
    }
    return "";
  }

  private threadIdFromPayload(payload: BlooioMessagePayload): string {
    const internalId = payload.internal_id;

    if (payload.is_group && payload.group_id) {
      return this.encodeThreadId({ internalId, groupId: payload.group_id });
    }

    const chatId =
      payload.event === "message.sent"
        ? payload.external_id
        : payload.sender;

    return this.encodeThreadId({ internalId, chatId });
  }

  private isProtocolAllowed(protocol: string): boolean {
    const allowed = this.config.allowedProtocols;
    if (!allowed || allowed.length === 0) return true;
    return allowed.some((p) => p.toLowerCase() === protocol.toLowerCase());
  }

  private resolveReaction(name: string): BlooioReaction | null {
    const lower = name.toLowerCase();
    if (VALID_REACTIONS.has(lower)) return lower as BlooioReaction;
    return REACTION_ALIASES[lower] ?? null;
  }

  private buildAttachment(url: string): Attachment {
    const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "heic", "webp"]);

    const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "";
    const isImage = IMAGE_EXTS.has(ext);
    return {
      type: isImage ? "image" : "file",
      name: url.split("/").pop()?.split("?")[0] ?? "attachment",
      mimeType: isImage
        ? `image/${ext === "jpg" ? "jpeg" : ext}`
        : "application/octet-stream",
      url,
      fetchData: async () => {
        const res = await fetch(url);
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }
}
