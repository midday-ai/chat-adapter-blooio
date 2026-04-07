# chat-adapter-blooio

[Blooio](https://blooio.com) adapter for [Chat SDK](https://chat-sdk.dev) — send and receive iMessage, RCS, and SMS from your bot.

## Install

```bash
npm install chat-adapter-blooio
```

## Quick start

```ts
import { Chat } from "chat";
import { createBlooioAdapter } from "chat-adapter-blooio";

const chat = new Chat({
  userName: "my-bot",
  adapters: {
    blooio: createBlooioAdapter(),
  },
});
```

The factory reads credentials from environment variables by default:

| Variable | Required | Description |
|---|---|---|
| `BLOOIO_API_KEY` | Yes | Blooio API key (Bearer token) |
| `BLOOIO_FROM_NUMBER` | No | Default sending phone number (E.164) for multi-number accounts |
| `BLOOIO_WEBHOOK_SECRET` | No | Webhook signing secret for HMAC-SHA256 verification |
| `BLOOIO_BASE_URL` | No | Override the API base URL (default: `https://backend.blooio.com/v2/api`) |

Or pass them explicitly:

```ts
createBlooioAdapter({
  apiKey: "your-api-key",
  defaultFromNumber: "+14155551234",
  webhookSecret: "whsec_...",
});
```

## Webhooks

Point your Blooio webhook URL to your server. The adapter handles these event types:

- **message.received** — incoming iMessage/RCS/SMS routed to your bot
- **message.sent** / **message.delivered** / **message.failed** / **message.read** — delivery lifecycle
- **message.reaction** — tapback reactions on messages

```ts
// Example: Hono / Express handler
app.post("/webhooks/blooio", async (c) => {
  await chat.initialize();
  return chat.webhooks.blooio(c.req.raw);
});
```

### Webhook signature verification

Blooio signs webhooks with HMAC-SHA256. The adapter verifies the `X-Blooio-Signature` header automatically when `webhookSecret` is configured. The signature format is:

```
X-Blooio-Signature: t=<unix_timestamp>,v1=<hmac_sha256_hex>
```

Stale timestamps are rejected (default tolerance: 300 seconds). Customize with:

```ts
createBlooioAdapter({
  webhookSecret: "whsec_...",
  timestampToleranceSec: 600, // 10 minutes
});
```

## Features

### Sending messages

The adapter sends outbound messages through Chat SDK's standard `postMessage` interface. Markdown is automatically stripped to plain text since iMessage does not render it.

```ts
await chat.send("blooio", threadId, "Hello from the bot!");
```

### Attachments

Send media via `sendMediaMessage`:

```ts
const adapter = chat.getAdapter("blooio") as BlooioAdapter;
await adapter.sendMediaMessage(threadId, "https://example.com/photo.jpg", "Check this out");
```

Inbound attachment URLs from Blooio webhooks are parsed into Chat SDK attachment objects with auto-detected MIME types.

### Reactions (tapbacks)

iMessage tapbacks are supported via `addReaction` and `removeReaction`. The adapter maps common emoji names to Blooio's six tapback types:

| Tapback | Aliases |
|---|---|
| `love` | `heart` |
| `like` | `thumbs_up`, `thumbsup`, `+1` |
| `dislike` | `thumbs_down`, `thumbsdown`, `-1` |
| `laugh` | `haha` |
| `emphasize` | `exclamation`, `!!` |
| `question` | `?` |

Unlike some platforms, Blooio supports **removing** reactions too.

### Typing indicators

`startTyping()` sends the animated "..." bubble to the recipient. Works for both 1:1 and group conversations.

### Message history

`fetchMessages()` retrieves conversation history from the Blooio API with cursor-based pagination (backed by offset/limit).

### Read receipts

Send read receipts for a conversation:

```ts
const adapter = chat.getAdapter("blooio") as BlooioAdapter;
await adapter.markRead(threadId);
```

### Contact capabilities

Check whether a contact supports iMessage or SMS:

```ts
const adapter = chat.getAdapter("blooio") as BlooioAdapter;
const result = await adapter.checkCapabilities("+15551234567");
// { contact: "+15551234567", capabilities: { imessage: true, sms: true } }
```

### Direct API client access

For anything not covered by the Chat SDK adapter interface, access the Blooio HTTP client directly:

```ts
const adapter = chat.getAdapter("blooio") as BlooioAdapter;
const client = adapter.getClient();

// Use any Blooio v2 API endpoint
await client.request("GET", "/contacts", undefined, { limit: "50" });
await client.request("POST", "/groups", { name: "Team", members: ["+15551234567"] });
```

## Protocol filtering

By default, the adapter processes inbound messages from all protocols (iMessage, RCS, SMS). To filter:

```ts
createBlooioAdapter({
  allowedProtocols: ["imessage"],
});
```

## Thread ID format

Thread IDs encode the Blooio device number and chat target so that conversations are sticky to a specific phone line:

```
blooio:<internalId_base64url>:<chatId_base64url>        // 1:1
blooio:<internalId_base64url>:g:<groupId_base64url>     // group
```

Use `encodeThreadId` / `decodeThreadId` to work with them programmatically.

## Platform limitations

- **No message editing** — iMessage does not support editing sent messages via API. `editMessage` throws.
- **No unsend** — `deleteMessage` is a no-op; iMessage messages cannot be unsent via API.
- **Inbound media** — attachment URLs from webhooks may expire. Persist them if needed.

## License

MIT
