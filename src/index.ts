import type { Logger } from "chat";
import { BlooioAdapter } from "./adapter";
import type { BlooioAdapterConfig } from "./types";

export { BlooioAdapter } from "./adapter";
export { BlooioClient, BlooioApiError } from "./client";
export { toPlainText } from "./format-converter";
export type {
  BlooioAdapterConfig,
  BlooioCapabilitiesResponse,
  BlooioErrorResponse,
  BlooioListMessagesParams,
  BlooioListMessagesResponse,
  BlooioMeResponse,
  BlooioMessageDetail,
  BlooioMessagePayload,
  BlooioProtocol,
  BlooioReaction,
  BlooioReactionPayload,
  BlooioReactionResponse,
  BlooioSendMessageBody,
  BlooioSendMessageResponse,
  BlooioThreadId,
  BlooioWebhookEvent,
  BlooioWebhookParticipant,
} from "./types";
export { REACTION_ALIASES, VALID_REACTIONS } from "./types";

export function createBlooioAdapter(
  config?: Partial<BlooioAdapterConfig> & { logger?: Logger },
): BlooioAdapter {
  const apiKey = config?.apiKey ?? process.env.BLOOIO_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Blooio API key is required. Pass it in config or set BLOOIO_API_KEY.",
    );
  }

  return new BlooioAdapter({
    apiKey,
    baseUrl: config?.baseUrl ?? process.env.BLOOIO_BASE_URL,
    defaultFromNumber:
      config?.defaultFromNumber ?? process.env.BLOOIO_FROM_NUMBER,
    webhookSecret:
      config?.webhookSecret ?? process.env.BLOOIO_WEBHOOK_SECRET,
    timestampToleranceSec: config?.timestampToleranceSec,
    allowedProtocols: config?.allowedProtocols,
    logger: config?.logger,
  });
}
