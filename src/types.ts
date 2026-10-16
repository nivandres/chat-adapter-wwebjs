import type { Author, Logger } from "chat";
import type {
  Call,
  Client,
  ClientOptions,
  GroupNotification,
  Message as WAMessage,
  PollVote,
} from "whatsapp-web.js";

/** Decoded thread ID components for WhatsApp. */
export interface WWebJSThreadId {
  /** WhatsApp chat ID, e.g. `"15551234567@c.us"` or `"1234567890-1234@g.us"`. */
  chatId: string;
}

/** Configuration for the whatsapp-web.js adapter. */
export interface WWebJSAdapterConfig {
  /**
   * Adapter identity used by Chat SDK serialization and thread ID prefixes.
   * Set a unique value per account when several run on one `Chat` instance.
   * Must not contain `:`. Defaults to `"wwebjs"`.
   */
  adapterName?: string;

  /**
   * An existing whatsapp-web.js client to drive. When omitted the adapter
   * constructs one from {@link WWebJSAdapterConfig.clientOptions}.
   */
  client?: Client;

  /** Options for the client the adapter constructs. Ignored when `client` is set. */
  clientOptions?: ClientOptions;

  /** Logger instance. Replaced by the Chat SDK logger once initialized. */
  logger?: Logger;

  /**
   * Acknowledge inbound messages automatically, so the sender sees blue ticks
   * as soon as the bot receives them. Defaults to `false`.
   */
  markSeen?: boolean;

  /**
   * Called with the 8-character pairing code when
   * {@link WWebJSAdapterConfig.phoneNumber} is set.
   */
  onPairingCode?: (code: string) => unknown;

  /**
   * Called with the QR string emitted during login. Render it with a library
   * like `qrcode-terminal`.
   */
  onQR?: (qr: string) => unknown;

  /**
   * Phone number for pairing-code login, in E.164 format without the leading
   * `+`. Shorthand for `clientOptions.pairWithPhoneNumber`.
   */
  phoneNumber?: string;

  /**
   * Largest inbound media, in bytes, that `fetchData()` downloads. Larger
   * media is refused before it is read into memory. Defaults to 64 MB.
   */
  maxMediaBytes?: number;

  /**
   * Deliver messages the paired account sent — from the phone or from this
   * adapter — to the Chat SDK, along with its own edits, deletes and
   * reactions. Defaults to `false`.
   */
  receiveOwnMessages?: boolean;

  /**
   * Open the session again when WhatsApp drops it, waiting longer after each
   * failed attempt. A logout is never retried, since it needs a new pairing.
   * Defaults to `true`.
   */
  reconnect?: boolean;

  /** Bot display name. Defaults to `"wwebjs-bot"`. */
  userName?: string;
}

/** Delivery state of a sent message, reported by {@link WWebJSAdapter.onAck}. */
export type WWebJSAckStatus = "delivered" | "error" | "pending" | "played" | "read" | "sent";

/** A delivery-state change for a message the bot sent. */
export interface WWebJSAck {
  /** Message ID whose delivery state changed. */
  messageId: string;
  /** Raw whatsapp-web.js message. */
  raw: WAMessage;
  /** New delivery state. */
  status: WWebJSAckStatus;
  /** Encoded thread ID the message belongs to. */
  threadId: string;
}

/** A participant returned by {@link WWebJSAdapter.fetchGroupParticipants}. */
export interface WWebJSGroupParticipant {
  /** True for both admin and super-admin roles. */
  isAdmin: boolean;
  /** True only for the group creator. */
  isSuperAdmin: boolean;
  /** The participant's chat ID, e.g. `"15551234567@c.us"`. */
  userId: string;
}

/** Membership or metadata change in a group. */
export interface WWebJSGroupEvent {
  /** Chat ID of whoever performed the action, when WhatsApp reports one. */
  authorId?: string;
  /** Raw whatsapp-web.js notification. */
  raw: GroupNotification;
  /** Encoded thread ID of the group. */
  threadId: string;
  /** What happened. */
  type: "admin_changed" | "join" | "leave" | "membership_request" | "update";
  /** Chat IDs the action applies to. */
  userIds: string[];
}

/** A vote on a poll the bot sent, delivered to {@link WWebJSAdapter.onPollVote}. */
export interface WWebJSPollVote {
  /** Original poll options, in send order. */
  options: string[];
  /** Message ID of the poll being voted on. */
  pollMessageId: string;
  /** Original poll question. */
  question: string;
  /** Raw whatsapp-web.js vote. */
  raw: PollVote;
  /** Options the voter currently has selected. Empty when the vote was cleared. */
  selectedOptions: string[];
  /** Encoded thread ID where the poll lives. */
  threadId: string;
  /** Author info for the voter. */
  voter: Author;
}

/** Named arguments for {@link WWebJSAdapter.sendLocation}. */
export interface WWebJSSendLocationArgs {
  /** Street address shown below the place name. */
  address?: string;
  /** Latitude in decimal degrees (WGS 84). */
  latitude: number;
  /** Longitude in decimal degrees (WGS 84). */
  longitude: number;
  /** Place name shown on the pin. */
  name?: string;
  /** Encoded thread ID that should receive the pin. */
  threadId: string;
  /** URL shown within the location message. */
  url?: string;
}

/** Named arguments for {@link WWebJSAdapter.sendPoll}. */
export interface WWebJSSendPollArgs {
  /** Let voters pick more than one option. Defaults to `false`. */
  allowMultipleAnswers?: boolean;
  /** Poll options, between 2 and 12. */
  options: string[];
  /** Poll question. */
  question: string;
  /** Encoded thread ID that should receive the poll. */
  threadId: string;
}

/** Named arguments for {@link WWebJSAdapter.sendEvent}. */
export interface WWebJSSendEventArgs {
  /** Type of WhatsApp call link to attach. Defaults to `"none"`. */
  callType?: "none" | "video" | "voice";
  /** Event description. */
  description?: string;
  /** When the event ends. */
  endTime?: Date;
  /** Where the event takes place. */
  location?: string;
  /** Event name. */
  name: string;
  /** When the event starts. */
  startTime: Date;
  /** Encoded thread ID that should receive the event. */
  threadId: string;
}

/** Handler for delivery-state changes. */
export type WWebJSAckHandler = (ack: WWebJSAck) => unknown;

/** Handler for incoming calls. */
export type WWebJSCallHandler = (call: Call) => unknown;

/** Handler for group membership and metadata changes. */
export type WWebJSGroupEventHandler = (event: WWebJSGroupEvent) => unknown;

/** Handler for poll votes. */
export type WWebJSPollVoteHandler = (vote: WWebJSPollVote) => unknown;
