import { createRequire } from "node:module";
import { ValidationError } from "@chat-adapter/shared";
import wwebjs from "whatsapp-web.js";

export const { Client, Location, MessageMedia, Poll, ScheduledEvent } = wwebjs;

/** The whatsapp-web.js commit this adapter is tested against, while no release reads current WhatsApp Web. */
export const TESTED_WWEBJS =
  "github:pedroslopez/whatsapp-web.js#38eb45b2759450cc6fccb6a7a3f2cbc3bdb87db2";

/** whatsapp-web.js waits this way, and times out, when WhatsApp Web changed under it; only another version fixes that. */
export function outdatedError(error: unknown): ValidationError | undefined {
  if (!/auth timeout|Waiting failed/i.test(String(error))) return undefined;
  let version = "unknown";
  try {
    version = createRequire(import.meta.url)("whatsapp-web.js/package.json").version;
  } catch {}
  return new ValidationError(
    "wwebjs",
    `WhatsApp Web did not load (${String(error)}). The installed whatsapp-web.js ${version} likely cannot read current WhatsApp Web; install ${TESTED_WWEBJS}.`,
  );
}
