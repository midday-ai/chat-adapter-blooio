import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { BlooioAdapter } from "../adapter";
import type { BlooioClient } from "../client";
import type { BlooioMessagePayload } from "../types";

const sendMessageMock = mock(() =>
  Promise.resolve({ message_id: "msg_123", status: "queued" }),
);
const listMessagesMock = mock(() =>
  Promise.resolve({
    chat_id: "+15551234567",
    messages: [],
    pagination: { limit: 20, offset: 0, total: 0 },
  }),
);
const addReactionMock = mock(() =>
  Promise.resolve({
    success: true,
    message_id: "msg_123",
    reaction: "love",
    action: "add",
  }),
);
const startTypingMock = mock(() => Promise.resolve(undefined));
const markReadMock = mock(() => Promise.resolve(undefined));
const checkCapabilitiesMock = mock(() =>
  Promise.resolve({
    contact: "+15551234567",
    capabilities: { imessage: true, sms: true },
  }),
);

function createFakeClient(): BlooioClient {
  return {
    sendMessage: sendMessageMock,
    listMessages: listMessagesMock,
    addReaction: addReactionMock,
    startTyping: startTypingMock,
    stopTyping: mock(() => Promise.resolve(undefined)),
    markRead: markReadMock,
    checkCapabilities: checkCapabilitiesMock,
    getMe: mock(() => Promise.resolve({ valid: true })),
    getMessageStatus: mock(() => Promise.resolve({})),
    request: mock(() => Promise.resolve({})),
  } as unknown as BlooioClient;
}

function createAdapter(overrides: Record<string, unknown> = {}) {
  return new BlooioAdapter({
    apiKey: "test-key",
    defaultFromNumber: "+14155551234",
    webhookSecret: "test-webhook-secret",
    client: createFakeClient(),
    ...overrides,
  });
}

function makePayload(
  overrides: Partial<BlooioMessagePayload> = {},
): BlooioMessagePayload {
  return {
    event: "message.received",
    message_id: "msg_abc",
    external_id: "+15559876543",
    text: "Hello from iMessage",
    attachments: [],
    protocol: "imessage",
    timestamp: Date.now(),
    internal_id: "+14155551234",
    received_at: Date.now(),
    sender: "+15559876543",
    is_group: false,
    group_id: null,
    group_name: null,
    participants: null,
    ...overrides,
  };
}

function signPayload(secret: string, body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${body}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("BlooioAdapter", () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    listMessagesMock.mockClear();
    addReactionMock.mockClear();
    startTypingMock.mockClear();
    markReadMock.mockClear();
  });

  // -------------------------------------------------------------------------
  // Thread ID round-trip
  // -------------------------------------------------------------------------

  describe("encodeThreadId / decodeThreadId", () => {
    test("round-trips a 1:1 thread ID", () => {
      const adapter = createAdapter();
      const data = {
        internalId: "+14155551234",
        chatId: "+15559876543",
      };
      const encoded = adapter.encodeThreadId(data);
      expect(encoded).toStartWith("blooio:");
      expect(adapter.decodeThreadId(encoded)).toEqual(data);
    });

    test("round-trips a group thread ID", () => {
      const adapter = createAdapter();
      const data = { internalId: "+14155551234", groupId: "grp_abc123" };
      const encoded = adapter.encodeThreadId(data);
      expect(encoded).toContain(":g:");
      expect(adapter.decodeThreadId(encoded)).toEqual(data);
    });

    test("throws on invalid thread ID", () => {
      const adapter = createAdapter();
      expect(() => adapter.decodeThreadId("bad_id")).toThrow(
        "Invalid Blooio thread ID",
      );
    });
  });

  // -------------------------------------------------------------------------
  // parseMessage
  // -------------------------------------------------------------------------

  describe("parseMessage", () => {
    test("produces correct Message fields from webhook payload", () => {
      const adapter = createAdapter();
      const payload = makePayload();
      const msg = adapter.parseMessage(payload);

      expect(msg.id).toBe("msg_abc");
      expect(msg.text).toBe("Hello from iMessage");
      expect(msg.author.userId).toBe("+15559876543");
      expect(msg.author.isBot).toBe(false);
      expect(msg.author.isMe).toBe(false);
      expect(msg.attachments).toHaveLength(0);
    });

    test("parses attachment URLs", () => {
      const adapter = createAdapter();
      const payload = makePayload({
        attachments: ["https://cdn.blooio.com/photo.jpg"],
      });
      const msg = adapter.parseMessage(payload);

      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]!.type).toBe("image");
      expect(msg.attachments[0]!.mimeType).toBe("image/jpeg");
      expect(msg.attachments[0]!.url).toBe("https://cdn.blooio.com/photo.jpg");
    });

    test("identifies outbound messages correctly", () => {
      const adapter = createAdapter();
      const payload = makePayload({ event: "message.sent" });
      const msg = adapter.parseMessage(payload);

      expect(msg.author.isBot).toBe(true);
      expect(msg.author.isMe).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // postMessage
  // -------------------------------------------------------------------------

  describe("postMessage", () => {
    test("sends via client.sendMessage with correct params", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        chatId: "+15559876543",
      });

      await adapter.postMessage(threadId, "Hello!");

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [chatId, body] = (sendMessageMock.mock.calls[0] as unknown[]) as [
        string,
        { text: string },
      ];
      expect(chatId).toBe("+15559876543");
      expect(body.text).toBe("Hello!");
    });

    test("skips sending empty content", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        chatId: "+15559876543",
      });

      const result = await adapter.postMessage(threadId, "   ");

      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(result.id).toBe("");
    });

    test("strips markdown from outbound messages", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        chatId: "+15559876543",
      });

      await adapter.postMessage(threadId, { markdown: "**bold** text" });

      const [, body] = (sendMessageMock.mock.calls[0] as unknown[]) as [
        string,
        { text: string },
      ];
      expect(body.text).toBe("bold text");
    });

    test("sends to group via groupId", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        groupId: "grp_abc123",
      });

      await adapter.postMessage(threadId, "Hello group!");

      const [chatId] = (sendMessageMock.mock.calls[0] as unknown[]) as [string, unknown];
      expect(chatId).toBe("grp_abc123");
    });
  });

  // -------------------------------------------------------------------------
  // sendMediaMessage
  // -------------------------------------------------------------------------

  describe("sendMediaMessage", () => {
    test("sends message with attachments", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        chatId: "+15559876543",
      });

      await adapter.sendMediaMessage(
        threadId,
        "https://example.com/file.pdf",
        "Check this out",
      );

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [chatId, body] = (sendMessageMock.mock.calls[0] as unknown[]) as [
        string,
        { text: string; attachments: string[] },
      ];
      expect(chatId).toBe("+15559876543");
      expect(body.text).toBe("Check this out");
      expect(body.attachments).toEqual(["https://example.com/file.pdf"]);
    });
  });

  // -------------------------------------------------------------------------
  // handleWebhook
  // -------------------------------------------------------------------------

  describe("handleWebhook", () => {
    test("rejects request with wrong webhook signature", async () => {
      const adapter = createAdapter();
      const body = JSON.stringify(makePayload());
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "x-blooio-event": "message.received",
          "x-blooio-signature": "t=123,v1=invalidsignature",
        },
        body,
      });

      const response = await adapter.handleWebhook(request);
      expect(response.status).toBe(401);
    });

    test("rejects request with missing signature header", async () => {
      const adapter = createAdapter();
      const body = JSON.stringify(makePayload());
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "x-blooio-event": "message.received",
        },
        body,
      });

      const response = await adapter.handleWebhook(request);
      expect(response.status).toBe(401);
    });

    test("accepts request with correct signature", async () => {
      const adapter = createAdapter();
      const body = JSON.stringify(makePayload());
      const signature = signPayload("test-webhook-secret", body);
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "x-blooio-event": "message.received",
          "x-blooio-signature": signature,
        },
        body,
      });

      const response = await adapter.handleWebhook(request);
      expect(response.status).toBe(200);
    });

    test("returns 400 for invalid JSON body", async () => {
      const adapter = createAdapter({ webhookSecret: undefined });
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "x-blooio-event": "message.received" },
        body: "not json",
      });

      const response = await adapter.handleWebhook(request);
      expect(response.status).toBe(400);
    });

    test("processes message.received events", async () => {
      const adapter = createAdapter({ webhookSecret: undefined });
      const payload = makePayload();
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "x-blooio-event": "message.received",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const response = await adapter.handleWebhook(request);
      expect(response.status).toBe(200);
    });

    test("acknowledges message.reaction events", async () => {
      const adapter = createAdapter({ webhookSecret: undefined });
      const request = new Request("https://example.com/webhook", {
        method: "POST",
        headers: {
          "x-blooio-event": "message.reaction",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event: "message.reaction",
          direction: "inbound",
          message_id: "msg_123",
          external_id: "+15559876543",
          reaction: "love",
          action: "add",
          sender: "+15559876543",
          original_text: "Hello!",
          timestamp: Date.now(),
          internal_id: "+14155551234",
        }),
      });

      const response = await adapter.handleWebhook(request);
      expect(response.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // channelIdFromThreadId
  // -------------------------------------------------------------------------

  test("channelIdFromThreadId returns adapter:internal prefix", () => {
    const adapter = createAdapter();
    const threadId = adapter.encodeThreadId({
      internalId: "+14155551234",
      chatId: "+15559876543",
    });
    const channelId = adapter.channelIdFromThreadId(threadId);
    expect(channelId).toStartWith("blooio:");
    expect(channelId.split(":")).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // addReaction / removeReaction
  // -------------------------------------------------------------------------

  describe("reactions", () => {
    test("addReaction sends +reaction", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        chatId: "+15559876543",
      });

      await adapter.addReaction(threadId, "msg_123", "love");

      expect(addReactionMock).toHaveBeenCalledTimes(1);
      const [chatId, messageId, reaction] = (addReactionMock.mock.calls[0] as unknown[]) as [
        string,
        string,
        string,
      ];
      expect(chatId).toBe("+15559876543");
      expect(messageId).toBe("msg_123");
      expect(reaction).toBe("+love");
    });

    test("removeReaction sends -reaction", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        chatId: "+15559876543",
      });

      await adapter.removeReaction(threadId, "msg_123", "love");

      expect(addReactionMock).toHaveBeenCalledTimes(1);
      const [, , reaction] = (addReactionMock.mock.calls[0] as unknown[]) as [
        string,
        string,
        string,
      ];
      expect(reaction).toBe("-love");
    });

    test("resolves reaction aliases", async () => {
      const adapter = createAdapter();
      const threadId = adapter.encodeThreadId({
        internalId: "+14155551234",
        chatId: "+15559876543",
      });

      await adapter.addReaction(threadId, "msg_123", "heart");

      const [, , reaction] = (addReactionMock.mock.calls[0] as unknown[]) as [
        string,
        string,
        string,
      ];
      expect(reaction).toBe("+love");
    });
  });
});
