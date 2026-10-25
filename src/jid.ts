const BROADCAST_SUFFIX = "@broadcast";
const GROUP_SUFFIX = "@g.us";
const NEWSLETTER_SUFFIX = "@newsletter";
const USER_SUFFIX = "@c.us";

/** True for group chat IDs, e.g. `"1234567890-1234567890@g.us"`. */
export function isGroupId(chatId: string): boolean {
  return chatId.endsWith(GROUP_SUFFIX);
}

/** True for channel (newsletter) IDs, e.g. `"1234567890@newsletter"`. */
export function isNewsletterId(chatId: string): boolean {
  return chatId.endsWith(NEWSLETTER_SUFFIX);
}

/** True for statuses and broadcast lists, e.g. `"status@broadcast"`. */
export function isBroadcastId(chatId: string): boolean {
  return chatId.endsWith(BROADCAST_SUFFIX);
}

/**
 * An ID whatsapp-web.js hands over as one of WhatsApp's own objects, which
 * carry `_serialized` or, since WhatsApp renamed it, `$1`.
 */
export function serialize(id: unknown): string {
  if (typeof id === "string") return id;
  const wid = id as { _serialized?: string; $1?: string } | null | undefined;
  return wid?._serialized ?? wid?.$1 ?? "";
}

/** True for one-to-one chat IDs, e.g. `"15551234567@c.us"`. */
export function isUserId(chatId: string): boolean {
  return !isGroupId(chatId) && !isNewsletterId(chatId) && !isBroadcastId(chatId);
}

/** Normalize a bare phone number into a WhatsApp chat ID. */
export function toChatId(value: string): string {
  return value.includes("@") ? value : `${value.replace(/\D/g, "")}${USER_SUFFIX}`;
}

/** The user part of a chat ID, e.g. `"15551234567@c.us"` → `"15551234567"`. */
export function toUser(chatId: string): string {
  return chatId.split("@")[0] ?? chatId;
}

/**
 * Rewrite Chat SDK mention tokens into WhatsApp's `@number` form and collect
 * the chat IDs WhatsApp needs alongside the body to render them as mentions.
 * A bare `@number` stays text, so echoing what someone wrote pings no one.
 */
export function extractMentions(text: string): { mentions: string[]; text: string } {
  const mentions = new Set<string>();
  const rendered = text.replace(/<@([^\s<>]+)>/g, (_match, id: string) => {
    const chatId = toChatId(id);
    mentions.add(chatId);
    return `@${toUser(chatId)}`;
  });
  return { mentions: [...mentions], text: rendered };
}
