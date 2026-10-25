import type { Author, CardElement, ChatInstance, Logger, Message } from "chat";
import type {
  Call,
  Client,
  ClientOptions,
  GroupNotification,
  Message as WAMessage,
  PollVote,
} from "whatsapp-web.js";
import type { WWebJSAdapter } from "./adapter.js";

/**
 * Where the WhatsApp session stands. Only `connected` can send and receive;
 * `logged_out` needs a new pairing, and `closed` follows `disconnect()`.
 */
export type WWebJSConnection =
  "closed" | "connected" | "connecting" | "disconnected" | "idle" | "logged_out" | "reconnecting";

/** Decoded thread ID components for WhatsApp. */
export interface WWebJSThreadId {
  /** WhatsApp chat ID, e.g. `"15551234567@c.us"` or `"1234567890-1234@g.us"`. */
  chatId: string;
}

/** Configuration for the whatsapp-web.js adapter. */
export interface WWebJSAdapterConfig {
  /**
   * Adapter identity used by Chat SDK serialization, thread ID prefixes and
   * state keys. Set a unique value per account when several run on one `Chat`
   * instance or share one state store. Must not contain `:`. Defaults to
   * `"wwebjs"`.
   */
  adapterName?: string;

  /** Layers that change how cards are sent or messages received; see `numberedActions()`. */
  addons?: WWebJSAddon[];

  /**
   * Messages that arrived while the session was down are delivered once it is
   * back, up to this old, oldest first. A restart part-way through delivers
   * them again rather than skip any, and the Chat SDK drops a repeat it has
   * already handled. Defaults to 1 day; `false` turns it off.
   */
  catchUpMs?: number | false;

  /**
   * An existing whatsapp-web.js client, exposed as `adapter.client`. One
   * already started is bridged as it is: `connect()` adopts its session
   * without a second `initialize()`, its options and listeners are left alone,
   * and its lifecycle stays yours — the adapter never reconnects or destroys
   * it, nor closes it on a signal, and `disconnect()` only detaches the
   * adapter. One never started is the adapter's to run, as if it had built
   * it; {@link WWebJSAdapterConfig.manageClient} decides otherwise. When
   * omitted the adapter constructs one from
   * {@link WWebJSAdapterConfig.clientOptions}.
   */
  client?: Client;

  /**
   * Options for the client the adapter constructs, Puppeteer's included.
   * `puppeteer.args` are added after {@link RECOMMENDED_CHROMIUM_ARGS}, so a
   * flag given here wins. Ignored when `client` is set.
   */
  clientOptions?: ClientOptions;

  /**
   * How long opening the session may take before it is abandoned — and, with
   * `reconnect`, tried again. whatsapp-web.js itself never gives up. Once a QR
   * or pairing code is shown it waits on a person instead, without limit.
   * Defaults to 2 minutes.
   */
  connectTimeoutMs?: number;

  /**
   * Close the session on SIGINT, SIGTERM and SIGHUP, then let the signal end
   * the process as it otherwise would — unless the app listens for it, and
   * shuts down itself. Puppeteer alone closes the browser and leaves the
   * process running. Defaults to `true`.
   */
  handleSignals?: boolean;

  /** Logger instance. Replaced by the Chat SDK logger once initialized. */
  logger?: Logger;

  /**
   * Force who runs a `client` you passed, whatever its state: `true` has the
   * adapter reconnect it, destroy it on `disconnect()` and close it on a
   * signal; `false` only bridges it. Decided by whether it was started when
   * omitted.
   */
  manageClient?: boolean;

  /** The few phrases a conversational modal sends, to put them in your users' language. */
  modalTexts?: Partial<WWebJSModalTexts>;

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
   * Render what WhatsApp can only imitate: cards in its markup with their
   * images as media, and modals as conversations. Off, a card is plain text
   * and the adapter has no `openModal`. Defaults to `false`.
   */
  richContent?: boolean;

  /**
   * Start Chromium with {@link RECOMMENDED_CHROMIUM_ARGS}, which keep it lean
   * and steady in a container. Defaults to `true`.
   */
  recommendedArgs?: boolean;

  /**
   * Open the session again when WhatsApp drops it, waiting longer after each
   * failed attempt. A logout is never retried, since it needs a new pairing.
   * Defaults to `true`.
   */
  reconnect?: boolean;

  /**
   * How often a connected session is asked whether WhatsApp still answers.
   * Two failed checks in a row count as a disconnect, which `reconnect` then
   * handles. Catches a session that died without any event. Defaults to 1
   * minute; `false` turns it off.
   */
  watchdogIntervalMs?: number | false;

  /**
   * Commands, such as `"/help"`, whose messages reach `onSlashCommand` rather
   * than the message handlers. `"/help me"` arrives as command `/help` with
   * text `"me"`. Any other text starting with `/` stays a message.
   */
  slashCommands?: string[];

  /**
   * How a streamed reply reaches WhatsApp. `"buffer"` sends it once, whole;
   * `"edit"` sends the first words and edits the message as the rest
   * arrives, at most once a second. Defaults to `"buffer"`.
   */
  streaming?: "buffer" | "edit";

  /** Bot display name. Defaults to `"wwebjs-bot"`. */
  userName?: string;

  /**
   * Send audio as a voice note, played inline with a waveform, rather than as
   * a file: `true` for all audio, `"ogg"` for OGG/Opus only, which every
   * phone plays as one, `false` for none. Defaults to `true`.
   */
  voiceNotes?: boolean | "ogg";
}

/** The phrases a conversational modal sends; `cancel` and `skip` are the words people answer with. */
export interface WWebJSModalTexts {
  cancel: string;
  cancelHint: string;
  cancelled: string;
  invalid: string;
  noResults: string;
  search: string;
  skip: string;
  skipHint: string;
}

/** What an addon is handed alongside each card or message. */
export interface WWebJSAddonContext {
  adapter: WWebJSAdapter;
  /** Absent until the Chat SDK has initialized the adapter. */
  chat: ChatInstance | null;
  threadId: string;
}

/** A layer over the adapter; every hook is optional. */
export interface WWebJSAddon {
  /** Text for a card in place of its plain fallback; the first addon to answer wins. */
  renderCard?(card: CardElement, context: WWebJSAddonContext): string | undefined;
  /** Called once a card is on WhatsApp, with the id of the message carrying it. */
  cardSent?(card: CardElement, messageId: string, context: WWebJSAddonContext): unknown;
  /** Return `true` to keep an inbound message from reaching the Chat SDK as one. */
  onMessage?(message: Message<WAMessage>, context: WWebJSAddonContext): boolean | Promise<boolean>;
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
