import { afterEach, describe, expect, test } from "bun:test";

const { BlooioClient, BlooioApiError } = await import("../client");

const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown) {
  const calls: [string, RequestInit][] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("BlooioClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sendMessage sends POST with correct URL and auth", async () => {
    const calls = mockFetch(202, {
      message_id: "msg_123",
      status: "queued",
    });

    const client = new BlooioClient({
      apiKey: "test-api-key",
      baseUrl: "https://backend.blooio.com/v2/api",
    });

    const result = await client.sendMessage("+15551234567", {
      text: "Hello!",
    });

    expect(result.message_id).toBe("msg_123");
    expect(calls).toHaveLength(1);

    const [url, init] = calls[0]!;
    expect(url).toBe(
      "https://backend.blooio.com/v2/api/chats/%2B15551234567/messages",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-api-key",
    );
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("Hello!");
  });

  test("sendMessage includes defaultFromNumber", async () => {
    const calls = mockFetch(202, { message_id: "msg_456", status: "queued" });

    const client = new BlooioClient({
      apiKey: "test-key",
      defaultFromNumber: "+14155551234",
    });

    await client.sendMessage("+15551234567", { text: "Hi" });

    const [, init] = calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.from_number).toBe("+14155551234");
  });

  test("listMessages sends GET with query params", async () => {
    const calls = mockFetch(200, {
      chat_id: "+15551234567",
      messages: [],
      pagination: { limit: 10, offset: 5, total: 50 },
    });

    const client = new BlooioClient({ apiKey: "test-key" });
    await client.listMessages("+15551234567", {
      limit: 10,
      offset: 5,
      sort: "desc",
    });

    const [url, init] = calls[0]!;
    expect(init.method).toBe("GET");
    expect(url).toContain("limit=10");
    expect(url).toContain("offset=5");
    expect(url).toContain("sort=desc");
  });

  test("addReaction sends POST with reaction body", async () => {
    const calls = mockFetch(200, {
      success: true,
      message_id: "msg_123",
      reaction: "love",
      action: "add",
    });

    const client = new BlooioClient({ apiKey: "test-key" });
    await client.addReaction("+15551234567", "msg_123", "+love");

    const [url, init] = calls[0]!;
    expect(url).toContain("/messages/msg_123/reactions");
    const body = JSON.parse(init.body as string);
    expect(body.reaction).toBe("+love");
  });

  test("startTyping sends POST to typing endpoint", async () => {
    const calls = mockFetch(200, { chat_id: "+15551234567", typing: true });

    const client = new BlooioClient({ apiKey: "test-key" });
    await client.startTyping("+15551234567");

    const [url, init] = calls[0]!;
    expect(url).toContain("/chats/%2B15551234567/typing");
    expect(init.method).toBe("POST");
  });

  test("markRead sends POST to read endpoint", async () => {
    const calls = mockFetch(200, {});

    const client = new BlooioClient({ apiKey: "test-key" });
    await client.markRead("+15551234567");

    const [url, init] = calls[0]!;
    expect(url).toContain("/chats/%2B15551234567/read");
    expect(init.method).toBe("POST");
  });

  test("URL-encodes phone numbers in chatId", async () => {
    const calls = mockFetch(202, {
      message_id: "msg_789",
      status: "queued",
    });

    const client = new BlooioClient({ apiKey: "test-key" });
    await client.sendMessage("+15551234567", { text: "Hi" });

    const [url] = calls[0]!;
    expect(url).toContain("%2B15551234567");
    expect(url).not.toContain("+1555");
  });

  test("throws BlooioApiError on 4xx responses", async () => {
    mockFetch(400, { error: "bad_request", message: "Invalid chatId" });

    const client = new BlooioClient({ apiKey: "test-key" });

    try {
      await client.sendMessage("invalid", { text: "Hi" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlooioApiError);
      const apiErr = err as InstanceType<typeof BlooioApiError>;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe("bad_request");
    }
  });

  test("throws BlooioApiError on 401 responses", async () => {
    mockFetch(401, { error: "unauthorized", status: 401 });

    const client = new BlooioClient({ apiKey: "bad-key" });

    try {
      await client.getMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlooioApiError);
      expect((err as InstanceType<typeof BlooioApiError>).status).toBe(401);
    }
  });

  test("handles group IDs without URL encoding issues", async () => {
    const calls = mockFetch(202, {
      message_id: "msg_grp",
      status: "queued",
    });

    const client = new BlooioClient({ apiKey: "test-key" });
    await client.sendMessage("grp_abc123", { text: "Hello group" });

    const [url] = calls[0]!;
    expect(url).toContain("/chats/grp_abc123/messages");
  });
});
