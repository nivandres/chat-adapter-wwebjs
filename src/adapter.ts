import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { extractCard, ResourceNotFoundError, ValidationError } from "@chat-adapter/shared";
import {
  ConsoleLogger,
  defaultEmojiResolver,
  Message,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type Author,
  type CardElement,
  type ChannelInfo,
  type ChannelVisibility,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type ListThreadsOptions,
  type ListThreadsResult,
  type LockScope,
  type Logger,
  type ModalElement,
  type RawMessage,
  type StreamChunk,
  type ThreadInfo,
  type ThreadSummary,
  type UserInfo,
  type WebhookOptions,
} from "chat";
import type {
  Chat as WAChat,
  Client,
  GroupChat,
  GroupNotification,
  Location as WALocation,
  Message as WAMessage,
  MessageAck,
  MessageContent,
  MessageSendOptions,
  PollVote,
  Reaction,
} from "whatsapp-web.js";
import {
  cardImages,
  cardToPlainText,
  cardToText,
  WWebJSFormatConverter,
} from "./format-converter.js";
import {
  extractMentions,
  isBroadcastId,
  isGroupId,
  isNewsletterId,
  serialize,
  toChatId,
  toUser,
} from "./jid.js";
import {
  download,
  isAudio,
  isCaptionable,
  isVoiceNote,
  toAttachments,
  toMedia,
  toMediaList,
} from "./media.js";
import {
  answerOf,
  createForm,
  currentField,
  DEFAULT_MODAL_TEXTS,
  flattenOptions,
  fromTrigger,
  introOf,
  questionOf,
  triggerIdOf,
  type Form,
} from "./modals.js";
import { closeOnSignal } from "./shutdown.js";
import type {
  WWebJSAck,
  WWebJSAckHandler,
  WWebJSAckStatus,
  WWebJSAdapterConfig,
  WWebJSAddon,
  WWebJSAddonContext,
  WWebJSCallHandler,
  WWebJSConnection,
  WWebJSGroupEvent,
  WWebJSGroupEventHandler,
  WWebJSGroupParticipant,
  WWebJSModalTexts,
  WWebJSPollVote,
  WWebJSPollVoteHandler,
  WWebJSSendEventArgs,
  WWebJSSendLocationArgs,
  WWebJSSendPollArgs,
  WWebJSThreadId,
} from "./types.js";
import { Client as WAClient, Location, Poll, ScheduledEvent } from "./wwebjs.js";

const ACK_STATUSES: Record<number, WWebJSAckStatus> = {
  [-1]: "error",
  0: "pending",
  1: "sent",
  2: "delivered",
  3: "read",
  4: "played",
};

const GROUP_EVENTS = {
  group_admin_changed: "admin_changed",
  group_join: "join",
  group_leave: "leave",
  group_membership_request: "membership_request",
  group_update: "update",
} as const satisfies Record<string, WWebJSGroupEvent["type"]>;

/** WhatsApp's own bookkeeping, which reaches `message_create` but is not something anyone said. */
const SYSTEM_TYPES = new Set([
  "broadcast_notification",
  "call_log",
  "ciphertext",
  "debug",
  "e2e_notification",
  "gp2",
  "group_notification",
  "notification",
  "notification_template",
  "protocol",
  "revoked",
]);

const DEFAULT_LIMIT = 50;
/** WhatsApp Web loads history into the page, so a read is bounded however far a cursor reaches. */
const MAX_HISTORY = 1000;
/** Contact lookups per message, so a message listing hundreds of mentions cannot queue hundreds of them. */
const MAX_MENTION_LOOKUPS = 20;
/** A contact or quoted message WhatsApp never returns must not hold the message back. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** WhatsApp refuses to edit a message for a few hundred milliseconds after sending it. */
const EDIT_RETRIES = 3;
const EDIT_RETRY_MS = 250;
const FRESH_MS = 5_000;
const CONNECT_TIMEOUT_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 300_000;
const KILL_WAIT_MS = 2_000;
/** WhatsApp takes an edit at a time; a second between them keeps a streamed reply readable and unthrottled. */
const STREAM_EDIT_MS = 1_000;
/** A modal left unanswered stops waiting for its answers. */
const FORM_TTL_MS = 86_400_000;
const MAX_POLL_OPTIONS = 12;
const MIN_POLL_OPTIONS = 2;
const CATCH_UP_MS = 86_400_000;
/** A session down for long must not flood the bot with every chat it has. */
const MAX_CATCH_UP_CHATS = 100;
const MAX_CATCH_UP_MESSAGES = 50;
/** Inbound ids remembered, so a message delivered live and caught up again is handled once. */
const MAX_RECENT = 1000;
/** A timestamp is set by the sender's device, so one from the future cannot move the position past what is still to come. */
const CLOCK_SKEW_S = 60;

/** What a single WhatsApp Web tab can do without, on top of the flags Puppeteer already passes. */
export const RECOMMENDED_CHROMIUM_ARGS = [
  "--renderer-process-limit=1",
  "--disable-gpu",
  "--disable-component-update",
];

interface PollVoteSubscription {
  filter?: Set<string>;
  handler: WWebJSPollVoteHandler;
}

/** The newest inbound message delivered, and every one sharing its second, so a restart catches up on exactly what it missed. */
interface Seen {
  at: number;
  ids: string[];
  /** The account it was recorded for; absent before 0.1.3. */
  wid?: string;
}

export class WWebJSAdapter implements Adapter<WWebJSThreadId, WAMessage> {
  readonly name: string;
  readonly lockScope: LockScope = "channel";

  /** The underlying whatsapp-web.js client, for anything this adapter does not wrap. */
  readonly client: Client;

  userName: string;

  /**
   * WhatsApp has no modals, so with `richContent` one becomes a conversation:
   * each field is asked in turn, a select by number, and the answers reach
   * `onModalSubmit`. `cancel`, or the modal's `closeLabel`, stops it. Absent
   * otherwise, so the SDK knows a modal cannot open.
   */
  readonly openModal?: (
    triggerId: string,
    modal: ModalElement,
    contextId?: string,
  ) => Promise<{ viewId: string }>;

  private readonly _config: WWebJSAdapterConfig;
  private readonly _converter = new WWebJSFormatConverter();
  private readonly _ackHandlers: WWebJSAckHandler[] = [];
  private readonly _callHandlers: WWebJSCallHandler[] = [];
  private readonly _groupHandlers: WWebJSGroupEventHandler[] = [];
  private readonly _pollVoteHandlers: PollVoteSubscription[] = [];
  private _chat: ChatInstance | null = null;
  private _logger: Logger;
  private _connection: Promise<void> | null = null;
  private _botLid?: string;
  private _closed = false;
  private _retry?: ReturnType<typeof setTimeout>;
  private _initialized = false;
  private _state: WWebJSConnection = "idle";
  private _watchdog?: ReturnType<typeof setInterval>;
  private _strikes = 0;
  private readonly _owned: boolean;
  private _attempts = 0;
  private _unwatch?: () => void;
  private _listeners: Array<Parameters<Client["off"]>> = [];
  private _unsignal?: () => void;
  private _seen?: Seen | null;
  private _behind?: WAMessage[];
  private readonly _recent = new Set<string>();
  private _saving: Promise<unknown> = Promise.resolve();

  constructor(config: WWebJSAdapterConfig = {}) {
    const name = config.adapterName ?? "wwebjs";
    if (name.includes(":")) {
      throw new ValidationError("wwebjs", `Invalid adapterName "${name}". ":" is not allowed.`);
    }

    this._config = config;
    this.name = name;
    this.userName = config.userName ?? "wwebjs-bot";
    this._logger = config.logger ?? new ConsoleLogger("info").child(name);
    this.client = config.client ?? new WAClient(this._clientOptions());
    // whatsapp-web.js tells media, locations and polls apart with `instanceof`, which fails across two installed copies.
    if (config.client?.constructor.name === "Client" && !(config.client instanceof WAClient)) {
      this._logger.warn(
        "This client comes from another copy of whatsapp-web.js than the adapter's, so the media, locations and polls it sends will fail. Install a single copy: it is a peer dependency.",
      );
    }
    // A client already started is someone else's to run, one never started the adapter's, unless told otherwise.
    this._owned = config.manageClient ?? !config.client?.pupBrowser?.isConnected();
    if (config.richContent) this.openModal = (...args) => this._openModal(...args);
    this._listen();
  }

  /** Where the session stands; a health check reads `connection === "connected"`. */
  get connection(): WWebJSConnection {
    return this._state;
  }

  get botUserId(): string | undefined {
    return this.client.info?.wid?._serialized;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this._chat = chat;
    this._logger = chat.getLogger(this.name);
  }

  /**
   * Launch the browser session and wait until WhatsApp is ready.
   *
   * Call this after registering handlers on your `Chat` instance, so no
   * message arrives before there is something to receive it. Repeated calls
   * share one connection attempt.
   */
  async connect(): Promise<void> {
    if (!this._chat) {
      this._logger.warn(
        "Connecting before Chat initialized — inbound messages are dropped until chat.initialize() runs.",
      );
    }
    this._closed = false;
    clearTimeout(this._retry);
    this._retry = undefined;
    if (this._listeners.length === 0) this._listen();
    this._watch();
    if (this._owned && this._config.handleSignals !== false) {
      this._unsignal ??= closeOnSignal(() => this.disconnect());
    }
    if (this._connection) return this._connection;
    // A newer attempt owns the connection; a superseded one must not reset it.
    const attempt = ++this._attempts;
    this._connection = this._connect(attempt).catch((error: unknown) => {
      if (attempt === this._attempts) {
        this._connection = null;
        if (this._state !== "logged_out" && !this._closed) this._state = "disconnected";
      }
      throw error;
    });
    return this._connection;
  }

  /** Close the browser session, or only detach from a client the adapter does not manage. */
  async disconnect(): Promise<void> {
    this._closed = true;
    this._state = "closed";
    clearTimeout(this._retry);
    clearInterval(this._watchdog);
    this._watchdog = undefined;
    this._connection = null;
    this._unsignal?.();
    this._unsignal = undefined;
    await this._saving;
    if (!this._owned) return this._unlisten();
    await this._close();
  }

  encodeThreadId(platformData: WWebJSThreadId): string {
    return `${this.name}:${platformData.chatId}`;
  }

  decodeThreadId(threadId: string): WWebJSThreadId {
    const prefix = `${this.name}:`;
    if (!threadId.startsWith(prefix)) {
      throw new ValidationError("wwebjs", `Invalid WhatsApp thread ID: ${threadId}`);
    }
    return { chatId: threadId.slice(prefix.length) };
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    const { chatId } = this.decodeThreadId(threadId);
    return !isGroupId(chatId) && !isNewsletterId(chatId) && !isBroadcastId(chatId);
  }

  getChannelVisibility(threadId: string): ChannelVisibility {
    return isNewsletterId(this.decodeThreadId(threadId).chatId) ? "external" : "private";
  }

  /**
   * whatsapp-web.js drives a browser session rather than inbound HTTP, so this
   * always answers 501. Call {@link WWebJSAdapter.connect} to receive messages.
   */
  async handleWebhook(_request: Request, _options?: WebhookOptions): Promise<Response> {
    return new Response(
      JSON.stringify({
        error:
          "The wwebjs adapter does not use HTTP webhooks. Call adapter.connect() to open the WhatsApp session.",
      }),
      { headers: { "Content-Type": "application/json" }, status: 501 },
    );
  }

  parseMessage(raw: WAMessage): Message<WAMessage> {
    const bot = this._botUsers();
    const text = this._named(
      raw.location ? locationText(raw.location) : (raw.body ?? ""),
      this._mentioned(raw).filter((user) => bot.has(user)),
      () => this.userName,
    );
    return new Message<WAMessage>({
      attachments: toAttachments(raw, this._config.maxMediaBytes),
      author: this._author(raw),
      formatted: this._converter.toAst(text),
      id: serialize(raw.id),
      isMention: this._mentionsBot(raw),
      links: (raw.links ?? []).map(({ link }) => ({ url: link })),
      metadata: {
        dateSent: new Date(raw.timestamp * 1000),
        edited: raw.latestEditSenderTimestampMs != null,
        editedAt: raw.latestEditSenderTimestampMs
          ? new Date(raw.latestEditSenderTimestampMs)
          : undefined,
      },
      raw,
      text,
      threadId: this.encodeThreadId({ chatId: chatIdOf(raw) }),
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WAMessage>> {
    return this._send(threadId, message);
  }

  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WAMessage>> {
    return this._send(channelId, message);
  }

  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WAMessage>> {
    return this._send(threadId, message, { quotedMessageId: messageId });
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WAMessage>> {
    const { card, text: rendered } = this._render(message, threadId);
    const { mentions, text } = extractMentions(rendered);
    const target = await this._requireMessage(messageId, threadId);
    const edit = () => target.edit(text, mentions.length > 0 ? { mentions } : undefined);
    let edited = await edit();
    const fresh = target.fromMe && Date.now() - target.timestamp * 1000 < FRESH_MS;
    for (let retry = 0; !edited && fresh && retry < EDIT_RETRIES; retry++) {
      await new Promise((resolve) => setTimeout(resolve, EDIT_RETRY_MS));
      edited = await edit();
    }
    if (!edited) {
      throw new ValidationError(
        "wwebjs",
        `Message ${messageId} could not be edited. WhatsApp only allows editing your own messages within 15 minutes.`,
      );
    }
    const raw = this._raw(edited, threadId);
    await this._cardSent(card, raw.id, threadId);
    return raw;
  }

  /** WhatsApp cannot stream, and editing twice a second as the SDK otherwise would floods the chat; the reply goes out once, whole. */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<WAMessage> | null> {
    const edits = this._config.streaming === "edit";
    let text = "";
    let sent: RawMessage<WAMessage> | undefined;
    let shown = "";
    let at = 0;
    for await (const chunk of textStream) {
      if (typeof chunk === "string") text += chunk;
      else if (chunk.type === "markdown_text") text += chunk.text;
      if (!edits || !text.trim() || Date.now() - at < STREAM_EDIT_MS) continue;
      // An edit WhatsApp refuses part-way only delays the words; the last one must land.
      sent = sent
        ? await this.editMessage(threadId, sent.id, { markdown: text }).catch(() => sent)
        : await this.postMessage(threadId, { markdown: text });
      shown = text;
      at = Date.now();
    }
    if (!text.trim()) return null;
    if (!sent) return this.postMessage(threadId, { markdown: text });
    return text === shown ? sent : this.editMessage(threadId, sent.id, { markdown: text });
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    await (await this._requireMessage(messageId, threadId)).delete(true);
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await (
      await this._requireMessage(messageId, threadId)
    ).react(defaultEmojiResolver.toGChat(emoji));
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    await (await this._requireMessage(messageId, threadId)).react("");
  }

  async fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<WAMessage>> {
    return this._page(await this._requireChat(threadId), options);
  }

  async fetchChannelMessages(
    channelId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<WAMessage>> {
    return this.fetchMessages(channelId, options);
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<WAMessage> | null> {
    const message = await this._findMessage(messageId, threadId);
    return message ? this.parseMessage(message) : null;
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this._findChat(chatId);
    return {
      channelId: threadId,
      channelName: chat?.name,
      channelVisibility: this.getChannelVisibility(threadId),
      id: threadId,
      isDM: this.isDM(threadId),
      metadata: { chatId },
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const { chatId } = this.decodeThreadId(channelId);
    const chat = await this._findChat(chatId);
    return {
      channelVisibility: this.getChannelVisibility(channelId),
      id: channelId,
      isDM: this.isDM(channelId),
      memberCount: isGroupChat(chat) ? chat.participants.length : undefined,
      metadata: { chatId },
      name: chat?.name,
    };
  }

  /** A WhatsApp chat is one flat conversation, so a channel holds just its own thread. */
  async listThreads(channelId: string): Promise<ListThreadsResult<WAMessage>> {
    const chat = await this._findChat(this.decodeThreadId(channelId).chatId);
    return { threads: chat ? this._summaries([chat]) : [] };
  }

  /** Every chat the account has, newest first, with its latest message: an inbox's list. */
  async listChats(options?: ListThreadsOptions): Promise<ListThreadsResult<WAMessage>> {
    const chats = (await this.client.getChats()).filter(
      (chat) => !isBroadcastId(serialize(chat.id)),
    );
    const start = Number(options?.cursor) || 0;
    const end = start + Math.max(1, options?.limit ?? DEFAULT_LIMIT);
    return {
      nextCursor: end < chats.length ? String(end) : undefined,
      threads: this._summaries(chats.slice(start, end)),
    };
  }

  private _summaries(chats: WAChat[]): ThreadSummary<WAMessage>[] {
    return chats.flatMap((chat) =>
      chat.lastMessage
        ? [
            {
              id: this.encodeThreadId({ chatId: serialize(chat.id) }),
              lastReplyAt: new Date(chat.lastMessage.timestamp * 1000),
              rootMessage: this.parseMessage(chat.lastMessage),
            },
          ]
        : [],
    );
  }

  private async _openModal(
    triggerId: string,
    modal: ModalElement,
    contextId?: string,
  ): Promise<{ viewId: string }> {
    const [threadId, userId] = fromTrigger(triggerId);
    const form = createForm(modal, randomUUID(), contextId);
    await this._start(threadId, userId, modal, form);
    return { viewId: form.viewId };
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    const contact = await this.client.getContactById(toChatId(userId)).catch(() => null);
    if (!contact) return null;
    const number = contact.number || toUser(contact.id._serialized);
    return {
      avatarUrl: await contact.getProfilePicUrl().catch(() => undefined),
      fullName: contact.name ?? contact.pushname ?? number,
      isBot: false,
      userId: contact.id._serialized,
      userName: contact.pushname || number,
    };
  }

  /** A number, or its `@c.us` id, resolves to the chat WhatsApp uses for it — often a LID — so a DM is one thread whoever opened it. */
  async openDM(userId: string): Promise<string> {
    if (userId.includes("@") && !userId.endsWith("@c.us")) {
      return this.encodeThreadId({ chatId: userId });
    }
    const resolved = await this.client.getNumberId(toUser(userId)).catch(() => null);
    return this.encodeThreadId({ chatId: resolved?._serialized ?? toChatId(userId) });
  }

  async markAsRead(threadId: string): Promise<void> {
    await (await this._requireChat(threadId)).sendSeen();
  }

  async startTyping(threadId: string, status?: string): Promise<void> {
    await this._indicator(threadId, "startTyping", (chat) =>
      status === "recording" ? chat.sendStateRecording() : chat.sendStateTyping(),
    );
  }

  async endTyping(threadId: string): Promise<void> {
    await this._indicator(threadId, "endTyping", (chat) => chat.clearState());
  }

  renderFormatted(content: FormattedContent): string {
    return this._converter.fromAst(content);
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    const messageId = attachment.fetchMetadata?.messageId;
    if (!messageId) return attachment;
    return {
      ...attachment,
      fetchData: async () =>
        download(await this._requireMessage(messageId), this._config.maxMediaBytes),
    };
  }

  /** Send a map pin. */
  async sendLocation(args: WWebJSSendLocationArgs): Promise<RawMessage<WAMessage>> {
    assertRange("latitude", args.latitude, 90);
    assertRange("longitude", args.longitude, 180);
    const location = new Location(args.latitude, args.longitude, {
      address: args.address,
      name: args.name,
      url: args.url,
    });
    return this._sendContent(args.threadId, location);
  }

  /** Send a native WhatsApp poll. Between 2 and 12 options. */
  async sendPoll(args: WWebJSSendPollArgs): Promise<RawMessage<WAMessage>> {
    if (args.options.length < MIN_POLL_OPTIONS || args.options.length > MAX_POLL_OPTIONS) {
      throw new ValidationError(
        "wwebjs",
        `sendPoll: WhatsApp polls need between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} options. Received ${args.options.length}.`,
      );
    }
    const poll = new Poll(args.question, args.options, {
      allowMultipleAnswers: args.allowMultipleAnswers,
      messageSecret: undefined,
    });
    return this._sendContent(args.threadId, poll);
  }

  /** Send a scheduled event card. */
  async sendEvent(args: WWebJSSendEventArgs): Promise<RawMessage<WAMessage>> {
    const event = new ScheduledEvent(args.name, args.startTime, {
      callType: args.callType ?? "none",
      description: args.description,
      endTime: args.endTime,
      location: args.location,
      messageSecret: undefined,
    });
    return this._sendContent(args.threadId, event);
  }

  /** Send an image as a sticker. */
  async sendSticker(
    threadId: string,
    source: Attachment | Parameters<typeof toMedia>[0],
  ): Promise<RawMessage<WAMessage>> {
    return this._sendContent(threadId, await toMedia(source, this._config.maxMediaBytes), {
      sendMediaAsSticker: true,
    });
  }

  /** Forward an existing message into another thread. */
  async forwardMessage(messageId: string, targetThreadId: string): Promise<void> {
    const { chatId } = this.decodeThreadId(targetThreadId);
    await (await this._requireMessage(messageId)).forward(chatId);
  }

  /** Pin a message for the given number of seconds. */
  async pinMessage(messageId: string, seconds: number): Promise<boolean> {
    return (await this._requireMessage(messageId)).pin(seconds);
  }

  /** Unpin a message. */
  async unpinMessage(messageId: string): Promise<boolean> {
    return (await this._requireMessage(messageId)).unpin();
  }

  /** Star a message. */
  async starMessage(messageId: string): Promise<void> {
    await (await this._requireMessage(messageId)).star();
  }

  /** Unstar a message. */
  async unstarMessage(messageId: string): Promise<void> {
    await (await this._requireMessage(messageId)).unstar();
  }

  /** Every pinned message in a thread. */
  async fetchPinnedMessages(threadId: string): Promise<Message<WAMessage>[]> {
    const { chatId } = this.decodeThreadId(threadId);
    const pinned = await this.client.getPinnedMessages(chatId);
    return pinned.map((message) => this.parseMessage(message));
  }

  /** Search messages across every chat, or within one thread. */
  async searchMessages(
    query: string,
    options?: { limit?: number; page?: number; threadId?: string },
  ): Promise<Message<WAMessage>[]> {
    const found = await this.client.searchMessages(query, {
      chatId: options?.threadId ? this.decodeThreadId(options.threadId).chatId : undefined,
      limit: options?.limit,
      page: options?.page,
    });
    return found.map((message) => this.parseMessage(message));
  }

  /** Participants of a group thread, with their admin status. */
  async fetchGroupParticipants(threadId: string): Promise<WWebJSGroupParticipant[]> {
    const chat = await this._requireChat(threadId);
    if (!isGroupChat(chat)) {
      throw new ValidationError("wwebjs", "fetchGroupParticipants: thread is not a group.");
    }
    return chat.participants.map((participant) => ({
      isAdmin: participant.isAdmin || participant.isSuperAdmin,
      isSuperAdmin: participant.isSuperAdmin,
      userId: participant.id._serialized,
    }));
  }

  /** The profile picture of a contact or group, when privacy settings allow it. */
  async getProfilePicUrl(userId: string): Promise<string | undefined> {
    return this.client.getProfilePicUrl(toChatId(userId)).catch(() => undefined);
  }

  /** Show the bot as online or offline. */
  async setPresence(presence: "available" | "unavailable"): Promise<void> {
    await (presence === "available"
      ? this.client.sendPresenceAvailable()
      : this.client.sendPresenceUnavailable());
  }

  /** Mark a thread unread. */
  async markAsUnread(threadId: string): Promise<void> {
    await (await this._requireChat(threadId)).markUnread();
  }

  /** Mute a thread until the given date, or forever when omitted. */
  async muteThread(threadId: string, until?: Date): Promise<void> {
    await (await this._requireChat(threadId)).mute(until);
  }

  /** Unmute a thread. */
  async unmuteThread(threadId: string): Promise<void> {
    await (await this._requireChat(threadId)).unmute();
  }

  /** Archive a thread. */
  async archiveThread(threadId: string): Promise<void> {
    await (await this._requireChat(threadId)).archive();
  }

  /** Move a thread out of the archive. */
  async unarchiveThread(threadId: string): Promise<void> {
    await (await this._requireChat(threadId)).unarchive();
  }

  /** Pin a thread to the top of the chat list. */
  async pinThread(threadId: string): Promise<boolean> {
    return (await this._requireChat(threadId)).pin();
  }

  /** Unpin a thread. */
  async unpinThread(threadId: string): Promise<boolean> {
    return (await this._requireChat(threadId)).unpin();
  }

  /**
   * Subscribe to votes on polls sent from this account, optionally narrowed to
   * specific poll message IDs.
   */
  onPollVote(handler: WWebJSPollVoteHandler): void;
  onPollVote(pollMessageIds: string | string[], handler: WWebJSPollVoteHandler): void;
  onPollVote(
    first: string | string[] | WWebJSPollVoteHandler,
    second?: WWebJSPollVoteHandler,
  ): void {
    if (typeof first === "function") {
      this._pollVoteHandlers.push({ handler: first });
      return;
    }
    if (!second) {
      throw new ValidationError(
        "wwebjs",
        "onPollVote: a handler is required when filtering by poll message ID.",
      );
    }
    this._pollVoteHandlers.push({
      filter: new Set(Array.isArray(first) ? first : [first]),
      handler: second,
    });
  }

  /** Subscribe to incoming calls. Use `call.reject()` to decline. */
  onCall(handler: WWebJSCallHandler): void {
    this._callHandlers.push(handler);
  }

  /** Subscribe to delivery-state changes for messages this account sent. */
  onAck(handler: WWebJSAckHandler): void {
    this._ackHandlers.push(handler);
  }

  /** Subscribe to group membership and metadata changes. */
  onGroupEvent(handler: WWebJSGroupEventHandler): void {
    this._groupHandlers.push(handler);
  }

  private _clientOptions() {
    const options = { ...this._config.clientOptions };
    const puppeteer = options.puppeteer ?? {};
    options.puppeteer = {
      // Puppeteer's handlers close the browser on a signal and keep the process alive; closeOnSignal does both.
      ...(this._config.handleSignals === false
        ? {}
        : { handleSIGHUP: false, handleSIGINT: false, handleSIGTERM: false }),
      ...puppeteer,
      args: [
        ...(this._config.recommendedArgs === false ? [] : RECOMMENDED_CHROMIUM_ARGS),
        ...(puppeteer.args ?? []),
      ],
    };
    if (this._config.phoneNumber) {
      options.pairWithPhoneNumber = {
        phoneNumber: this._config.phoneNumber,
        ...options.pairWithPhoneNumber,
      };
    }
    return options;
  }

  private async _connect(attempt: number): Promise<void> {
    const timeoutMs = this._config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new ValidationError("wwebjs", `WhatsApp was not ready within ${timeoutMs}ms.`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    // A QR or pairing code means the session is up and waiting on a person, which no timeout should cut short.
    const waiting = () => clearTimeout(timer);
    this.client.once("qr", waiting);
    this.client.once("code", waiting);
    try {
      await Promise.race([this._open(), timedOut]);
    } catch (error) {
      // An abandoned attempt keeps its browser otherwise; a superseded one leaves the newer attempt's alone.
      if (this._owned && attempt === this._attempts) await this._close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
      this.client.off("qr", waiting);
      this.client.off("code", waiting);
    }
  }

  private async _open(): Promise<void> {
    this._state = this._initialized ? "reconnecting" : "connecting";
    if (!this._owned && (await this._running())) {
      this._watchBrowser();
      return this._onReady();
    }
    let onReady!: () => void;
    let onFailure!: (message: string) => void;
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      onFailure = (message) =>
        reject(new ValidationError("wwebjs", `WhatsApp authentication failed: ${message}`));
    });
    // Rejected while initialize() still runs, before anything awaits it.
    ready.catch(() => undefined);
    this.client.on("ready", onReady);
    this.client.on("auth_failure", onFailure);
    try {
      // A previous session's browser is closed first, or every reconnect would leave one running.
      if (this._owned && this._initialized) await this._close().catch(() => undefined);
      this._initialized = true;
      // A client someone else already started is waited on, never started twice.
      if (this._owned || !this.client.pupBrowser) await this.client.initialize();
      if (this._closed) {
        if (this._owned) await this._close();
        return;
      }
      this._watchBrowser();
      await ready;
    } finally {
      this.client.off("ready", onReady);
      this.client.off("auth_failure", onFailure);
    }
  }

  /** A crashed browser ends the session without WhatsApp ever reporting a disconnect. */
  private _watchBrowser(): void {
    const browser = this.client.pupBrowser;
    if (!browser) return;
    const onClose = () => this._onDisconnected("BROWSER_CLOSED");
    browser.once("disconnected", onClose);
    this._unwatch = () => browser.off("disconnected", onClose);
  }

  /** A client started elsewhere is up when its browser is connected and WhatsApp answers. */
  private async _running(): Promise<boolean> {
    if (!this.client.pupBrowser?.isConnected()) return false;
    return (await within(this.client.getState())) === "CONNECTED";
  }

  /** Closes the browser this adapter runs; closing it on purpose is not a crash to recover from. */
  private async _close(): Promise<void> {
    this._unwatch?.();
    this._unwatch = undefined;
    try {
      await this.client.destroy();
    } finally {
      await this._killBrowser();
    }
  }

  /** `destroy()` closes only a browser it still sees connected, so one that dropped keeps its profile locked. */
  private async _killBrowser(): Promise<void> {
    const browser = this.client.pupBrowser?.process?.();
    if (!browser?.pid || browser.exitCode !== null || browser.signalCode !== null) return;
    const exited = once(browser, "exit");
    try {
      process.kill(process.platform === "win32" ? browser.pid : -browser.pid, "SIGKILL");
    } catch {
      browser.kill("SIGKILL");
    }
    // The next browser cannot open the profile until this one is gone.
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, KILL_WAIT_MS).unref?.()),
    ]);
  }

  private _listen(): void {
    const { onPairingCode, onQR } = this._config;
    // Recorded, so a client the adapter only bridges can be handed back without them.
    const on: Client["on"] = (event: string, listener: Parameters<Client["off"]>[1]) => {
      this._listeners.push([event, listener]);
      return this.client.on(event, listener);
    };
    if (onQR) on("qr", (qr) => void this._dispatch([onQR], qr, "onQR"));
    if (onPairingCode)
      on("code", (code) => void this._dispatch([onPairingCode], code, "onPairingCode"));

    on("ready", () => this._onReady());
    on("disconnected", (reason) => this._onDisconnected(String(reason)));
    on("message_create", (message) => this._guard("message", this._onMessage(message)));
    on("message_edit", (message, _new, previous) => this._onEdit(message, String(previous)));
    on("message_revoke_everyone", (message, revoked) => this._onRevoke(message, revoked));
    on("message_reaction", (reaction) => this._onReaction(reaction));
    on("message_ack", (message, ack) => this._onAck(message, ack));
    on("vote_update", (vote) => this._guard("poll vote", this._onVote(vote)));
    on("call", (call) => void this._dispatch(this._callHandlers, call, "onCall"));
    for (const [event, type] of Object.entries(GROUP_EVENTS)) {
      on(event, (notification: GroupNotification) => this._onGroup(type, notification));
    }
  }

  private _unlisten(): void {
    for (const [event, listener] of this._listeners) this.client.off(event, listener);
    this._listeners = [];
  }

  private _onReady(): void {
    this._state = "connected";
    this._strikes = 0;
    if (!this._config.userName && this.client.info?.pushname) {
      this.userName = this.client.info.pushname;
    }
    this._logger.info("WhatsApp session ready", { userId: this.botUserId });
    void this._learnLid();
    this._guard("catch-up", this._catchUp());
  }

  private async _onMessage(raw: WAMessage): Promise<void> {
    if (!this._chat || this._isOwn(raw.fromMe)) return;
    const chatId = chatIdOf(raw);
    if (raw.isStatus || isBroadcastId(chatId) || SYSTEM_TYPES.has(raw.type)) return;
    const id = serialize(raw.id);
    if (this._recent.has(id)) return;
    this._recent.add(id);
    if (this._recent.size > MAX_RECENT) this._recent.delete(this._recent.values().next().value!);

    const threadId = this.encodeThreadId({ chatId });
    if (this._config.markSeen && !raw.fromMe) {
      await this.markAsRead(threadId).catch((error) =>
        this._logger.warn("Failed to send a read receipt", { error, threadId }),
      );
    }
    const author = this._author(raw);
    if ((await this._answer(raw, threadId, author)) || this._command(raw, threadId, author)) {
      await this._remember(raw);
      return;
    }
    const parsed = this._addons("onMessage").length > 0 ? await this._parse(raw) : undefined;
    if (!parsed || !(await this._claimed(parsed, threadId))) {
      await this._chat.processMessage(this, threadId, parsed ?? (() => this._parse(raw)));
    }
    await this._remember(raw);
  }

  private _formKey(threadId: string, userId: string): string {
    return `wwebjs:${this.name}:form:${threadId}:${userId}`;
  }

  private _texts(): WWebJSModalTexts {
    return { ...DEFAULT_MODAL_TEXTS, ...this._config.modalTexts };
  }

  private async _start(
    threadId: string,
    userId: string,
    modal: ModalElement,
    form: Form,
  ): Promise<void> {
    if (!this._chat) throw new ValidationError("wwebjs", "A modal needs Chat to be initialized.");
    const field = currentField(form);
    await this._chat.getState().set(this._formKey(threadId, userId), form, FORM_TTL_MS);
    const intro = introOf(modal, this._texts());
    await this.postMessage(
      threadId,
      field ? `${intro}\n\n${questionOf(field, form, this._texts())}` : intro,
    );
  }

  /** A reply from someone filling in a modal answers it, before anything else sees it. */
  private async _answer(raw: WAMessage, threadId: string, user: Author): Promise<boolean> {
    const state = this._chat!.getState();
    const key = this._formKey(threadId, user.userId);
    const form = await state.get<Form>(key);
    const field = form && currentField(form);
    if (!form || !field) return false;
    const texts = this._texts();
    const text = (raw.body ?? "").trim();
    const event = { adapter: this, callbackId: form.callbackId, raw, user, viewId: form.viewId };
    if (text.toLowerCase() === (form.closeLabel ?? texts.cancel).toLowerCase()) {
      await state.delete(key);
      await this.postMessage(threadId, texts.cancelled);
      if (form.notifyOnClose) {
        await this._chat!.processModalClose(
          { ...event, privateMetadata: form.privateMetadata },
          form.contextId,
        );
      }
      return true;
    }
    const answer = answerOf(field, form, text, texts);
    if ("search" in answer) {
      const found = flattenOptions(
        await this._chat!.processOptionsLoad({
          actionId: field.id,
          adapter: this,
          query: answer.search,
          raw,
          user,
        }),
      );
      const next = { ...form, found: found.length > 0 ? found : undefined };
      await state.set(key, next, FORM_TTL_MS);
      const question = questionOf(field, next, texts);
      await this.postMessage(
        threadId,
        found.length > 0 ? question : `${texts.noResults}\n\n${question}`,
      );
      return true;
    }
    if ("error" in answer) {
      await this.postMessage(threadId, `${answer.error}\n\n${questionOf(field, form, texts)}`);
      return true;
    }
    const { [field.id]: _previous, ...rest } = form.values;
    const next: Form = {
      ...form,
      found: undefined,
      pending: form.pending.slice(1),
      values: answer.value === undefined ? rest : { ...rest, [field.id]: answer.value },
    };
    const following = currentField(next);
    if (following) {
      await state.set(key, next, FORM_TTL_MS);
      await this.postMessage(threadId, questionOf(following, next, texts));
      return true;
    }
    await state.delete(key);
    const response = await this._chat!.processModalSubmit(
      { ...event, privateMetadata: next.privateMetadata, values: next.values },
      next.contextId,
    );
    if (response?.action === "errors") {
      const retry = {
        ...next,
        pending: next.fields.map(({ id }) => id).filter((id) => id in response.errors),
      };
      const first = currentField(retry);
      if (first) {
        await state.set(key, retry, FORM_TTL_MS);
        const reasons = Object.values(response.errors).join("\n");
        await this.postMessage(threadId, `${reasons}\n\n${questionOf(first, retry, texts)}`);
      }
    } else if (response?.action === "update" || response?.action === "push") {
      const viewId = response.action === "update" ? next.viewId : randomUUID();
      await this._start(
        threadId,
        user.userId,
        response.modal,
        createForm(response.modal, viewId, next.contextId),
      );
    }
    return true;
  }

  /** WhatsApp has no slash commands, so a message naming a declared one becomes one. */
  private _command(raw: WAMessage, threadId: string, user: Author): boolean {
    const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec((raw.body ?? "").trim());
    const command =
      match &&
      this._config.slashCommands?.find((name) => name.toLowerCase() === match[1]!.toLowerCase());
    if (!command) return false;
    this._chat!.processSlashCommand(
      {
        adapter: this,
        channelId: threadId,
        command,
        raw,
        text: match[2] ?? "",
        triggerId: triggerIdOf(threadId, user.userId),
        user,
      },
      undefined,
    );
    return true;
  }

  private async _claimed(message: Message<WAMessage>, threadId: string): Promise<boolean> {
    for (const addon of this._addons("onMessage")) {
      if (await addon.onMessage!(message, this._context(threadId))) return true;
    }
    return false;
  }

  private _addons<K extends keyof WWebJSAddon>(hook: K): WWebJSAddon[] {
    return (this._config.addons ?? []).filter((addon) => addon[hook]);
  }

  private _context(threadId: string): WWebJSAddonContext {
    return { adapter: this, chat: this._chat, threadId };
  }

  private _seenKey(): string {
    return `wwebjs:${this.name}:seen`;
  }

  /** Writes run in turn, so an older position never lands after a newer one. */
  private _save(): Promise<unknown> {
    const state = this._chat?.getState();
    if (!state) return Promise.resolve();
    this._saving = this._saving
      .then(() => state.set(this._seenKey(), this._seen))
      .catch((error: unknown) =>
        this._logger.warn("Could not record the last message delivered", { error }),
      );
    return this._saving;
  }

  /** While a catch-up runs the position holds still, so a crash part-way replays rather than skips. */
  private async _remember(raw: WAMessage): Promise<void> {
    if (this._config.catchUpMs === false) return;
    if (this._behind) this._behind.push(raw);
    else if (this._advance(raw)) await this._save();
  }

  private _advance(raw: WAMessage): boolean {
    if (!this._seen) return false;
    const id = serialize(raw.id);
    const at = Math.min(raw.timestamp, Math.floor(Date.now() / 1000) + CLOCK_SKEW_S);
    const { ids } = this._seen;
    if (at < this._seen.at || (at === this._seen.at && ids.includes(id))) return false;
    this._seen = { at, ids: at === this._seen.at ? [...ids, id] : [id], wid: this.botUserId };
    return true;
  }

  /** WhatsApp Web loads what arrived while the session was down without announcing every message. */
  private async _catchUp(): Promise<void> {
    const windowMs = this._config.catchUpMs ?? CATCH_UP_MS;
    const state = this._chat?.getState();
    if (windowMs === false || !state) return;
    this._seen ??= await state.get<Seen>(this._seenKey());
    // A position recorded for another number, as after pairing a new one, is no position at all.
    if (this._seen?.wid && this._seen.wid !== this.botUserId) this._seen = null;
    const seen = this._seen;
    if (!seen) {
      this._seen = { at: Math.floor(Date.now() / 1000), ids: [], wid: this.botUserId };
      await this._save();
      return;
    }
    const oldest = Math.max(seen.at, Math.floor((Date.now() - windowMs) / 1000));
    const unseen = (message: WAMessage) =>
      message.timestamp > oldest ||
      (message.timestamp === seen.at && !seen.ids.includes(serialize(message.id)));
    this._behind = [];
    try {
      const chats = (await this.client.getChats()).filter((chat) => chat.timestamp >= oldest);
      const missed: WAMessage[] = [];
      let truncated = chats.length > MAX_CATCH_UP_CHATS;
      for (const chat of chats.slice(0, MAX_CATCH_UP_CHATS)) {
        const messages = await chat
          .fetchMessages({ limit: MAX_CATCH_UP_MESSAGES })
          .catch((error: unknown) => {
            this._logger.warn("Could not catch up on a chat", {
              chatId: serialize(chat.id),
              error,
            });
            return [];
          });
        const behind = messages.filter(unseen);
        truncated ||= behind.length === MAX_CATCH_UP_MESSAGES;
        missed.push(...behind);
      }
      if (truncated) {
        this._logger.warn(
          `Caught up on the ${MAX_CATCH_UP_CHATS} most recent chats and ${MAX_CATCH_UP_MESSAGES} messages each; older ones were missed`,
        );
      }
      for (const message of missed.sort((a, b) => a.timestamp - b.timestamp)) {
        await this._onMessage(message).catch((error: unknown) =>
          this._logger.warn("A missed message was not handled", {
            error,
            messageId: serialize(message.id),
          }),
        );
      }
    } finally {
      const delivered = this._behind;
      this._behind = undefined;
      if (delivered.map((message) => this._advance(message)).some(Boolean)) await this._save();
    }
  }

  private _onEdit(raw: WAMessage, previousBody: string): void {
    if (this._isOwn(raw.fromMe)) return;
    this._chat?.processMessageUpdated({
      adapter: this,
      message: () => this._parse(raw),
      previousMessage: async () => {
        const previous = this.parseMessage(raw);
        previous.text = previousBody;
        previous.formatted = this._converter.toAst(previousBody);
        return previous;
      },
      threadId: this.encodeThreadId({ chatId: chatIdOf(raw) }),
    });
  }

  private _onRevoke(raw: WAMessage, revoked?: WAMessage | null): void {
    if (this._isOwn(raw.fromMe)) return;
    const threadId = this.encodeThreadId({ chatId: chatIdOf(raw) });
    this._chat?.processMessageDeleted({
      adapter: this,
      channelId: threadId,
      deletedAt: new Date(raw.timestamp * 1000),
      messageId: serialize(revoked?.id) || serialize(raw.protocolMessageKey) || raw.id._serialized,
      previousMessage: revoked ? this.parseMessage(revoked) : undefined,
      raw,
      threadId,
    });
  }

  private _onReaction(reaction: Reaction): void {
    if (this._isOwn(reaction.id.fromMe)) return;
    this._chat?.processReaction({
      adapter: this,
      added: reaction.reaction.length > 0,
      emoji: defaultEmojiResolver.fromGChat(reaction.reaction),
      messageId: serialize(reaction.msgId),
      raw: reaction,
      rawEmoji: reaction.reaction,
      threadId: this.encodeThreadId({ chatId: serialize(reaction.id.remote) }),
      user: participantAuthor(serialize(reaction.senderId), reaction.id.fromMe),
    });
  }

  private _onAck(raw: WAMessage, ack: MessageAck): void {
    void this._dispatch(
      this._ackHandlers,
      {
        messageId: raw.id._serialized,
        raw,
        status: ACK_STATUSES[ack] ?? "pending",
        threadId: this.encodeThreadId({ chatId: chatIdOf(raw) }),
      } satisfies WWebJSAck,
      "onAck",
    );
  }

  private _onGroup(type: WWebJSGroupEvent["type"], notification: GroupNotification): void {
    const threadId = this.encodeThreadId({ chatId: notification.chatId });
    void this._dispatch(
      this._groupHandlers,
      {
        authorId: notification.author,
        raw: notification,
        threadId,
        type,
        userIds: notification.recipientIds.map(serialize),
      } satisfies WWebJSGroupEvent,
      "onGroupEvent",
    );
    if (type !== "join" || !this._chat) return;
    for (const userId of notification.recipientIds.map(serialize)) {
      this._chat.processMemberJoinedChannel({
        adapter: this,
        channelId: threadId,
        inviterId: notification.author,
        userId,
      });
    }
  }

  private async _onVote(vote: PollVote): Promise<void> {
    const parent = vote.parentMessage;
    // Unloadable polls arrive without a parent, and polls sent by others are not this account's to count.
    if (!parent?.id || !parent.fromMe) return;
    const pollMessageId = parent.id._serialized;
    const payload: WWebJSPollVote = {
      options: parent.pollOptions ?? [],
      pollMessageId,
      question: parent.pollName,
      raw: vote,
      selectedOptions: vote.selectedOptions.map((option) => option.name),
      threadId: this.encodeThreadId({ chatId: chatIdOf(parent) }),
      voter: participantAuthor(serialize(vote.voter), false),
    };
    await this._dispatch(
      this._pollVoteHandlers
        .filter(({ filter }) => !filter || filter.has(pollMessageId))
        .map(({ handler }) => handler),
      payload,
      "onPollVote",
    );
  }

  private async _dispatch<T>(
    handlers: Array<(value: T) => unknown>,
    value: T,
    label: string,
  ): Promise<void> {
    for (const handler of handlers) {
      try {
        await handler(value);
      } catch (error) {
        this._logger.error(`${label} handler threw`, error);
      }
    }
  }

  private async _parse(raw: WAMessage): Promise<Message<WAMessage>> {
    const parsed = this.parseMessage(raw);
    const bot = this._botUsers();
    const others = [
      ...new Set((raw.mentionedIds ?? []).map(serialize).filter((id) => !bot.has(toUser(id)))),
    ].slice(0, MAX_MENTION_LOOKUPS);
    if (others.length > 0) {
      const names = new Map<string, string>();
      for (const id of others) {
        const contact = await within(this.client.getContactById(id));
        const name = contact?.pushname || contact?.name;
        if (name) names.set(toUser(id), name);
      }
      parsed.text = this._named(parsed.text, [...names.keys()], (user) => names.get(user)!);
      parsed.formatted = this._converter.toAst(parsed.text);
    }
    if (raw.hasQuotedMsg) {
      const quoted = await within(raw.getQuotedMessage());
      if (quoted) parsed.replyTo = this.parseMessage(quoted);
      if (quoted?.fromMe) parsed.isMention = true;
    }
    return parsed;
  }

  private _author(raw: WAMessage): Author {
    const chatId = chatIdOf(raw);
    const userId = raw.fromMe
      ? (this.botUserId ?? chatId)
      : isGroupId(chatId)
        ? (raw.author ?? chatId)
        : chatId;
    const pushName = (raw.rawData as { notifyName?: string } | undefined)?.notifyName;
    return {
      fullName: pushName ?? "",
      isBot: raw.fromMe,
      isMe: raw.fromMe,
      userId,
      userName: pushName || toUser(userId),
    };
  }

  private async _indicator(
    threadId: string,
    label: string,
    send: (chat: WAChat) => Promise<unknown>,
  ): Promise<void> {
    try {
      await send(await this._requireChat(threadId));
    } catch (error) {
      this._logger.warn(`${label} failed`, { error, threadId });
    }
  }

  /** Groups address the bot by its LID or its phone number, whichever they know it by. */
  private _mentionsBot(raw: WAMessage): boolean {
    const bot = this._botUsers();
    return this._mentioned(raw).some((user) => bot.has(user));
  }

  private _botUsers(): Set<string> {
    return new Set([this.botUserId, this._botLid].filter(Boolean).map((id) => toUser(id!)));
  }

  private _mentioned(raw: WAMessage): string[] {
    return (raw.mentionedIds ?? []).map((id) => toUser(serialize(id)));
  }

  /** WhatsApp writes a mention as `@` and the number or LID; readers expect the name. */
  private _named(text: string, users: string[], name: (user: string) => string): string {
    // Whole ids only, so `@123` never renames the start of `@1234`; a replacer, so a name cannot carry `$'`.
    return text.replace(/@(\d+)(?!\d)/g, (mention, user: string) =>
      users.includes(user) ? `@${name(user)}` : mention,
    );
  }

  private async _learnLid(): Promise<void> {
    const botUserId = this.botUserId;
    if (!botUserId) return;
    try {
      const [ids] = await this.client.getContactLidAndPhone([botUserId]);
      this._botLid = ids?.lid;
    } catch (error) {
      this._logger.warn("Could not learn the bot's LID; mentions by LID will be missed", { error });
    }
  }

  /** Listeners run unawaited, so a rejection here would end the process. */
  private _guard(label: string, work: Promise<unknown>): void {
    work.catch((error: unknown) =>
      this._logger.warn(`Inbound ${label} was not handled`, { error }),
    );
  }

  private _isOwn(fromMe: boolean): boolean {
    return fromMe && !this._config.receiveOwnMessages;
  }

  private _onDisconnected(reason: string): void {
    if (this._closed) return;
    this._connection = null;
    this._state = this._reconnects() ? "reconnecting" : "disconnected";
    if (reason === "LOGOUT") {
      this._state = "logged_out";
      this._logger.error("WhatsApp logged this session out; pair it again to reconnect", {
        reason,
      });
      return;
    }
    this._logger.warn("WhatsApp disconnected", { reason });
    this._reconnect(RECONNECT_MIN_MS);
  }

  private _reconnects(): boolean {
    return this._owned && this._config.reconnect !== false;
  }

  private _reconnect(delayMs: number): void {
    if (this._closed || !this._reconnects()) return;
    clearTimeout(this._retry);
    this._state = "reconnecting";
    this._retry = setTimeout(() => {
      this._retry = undefined;
      this.connect().catch((error: unknown) => {
        this._logger.warn("Reconnecting to WhatsApp failed", { error, delayMs });
        this._reconnect(Math.min(delayMs * 2, RECONNECT_MAX_MS));
      });
    }, delayMs);
    this._retry.unref?.();
  }

  private _watch(): void {
    const everyMs = this._config.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS;
    if (this._watchdog || everyMs === false) return;
    this._watchdog = setInterval(() => this._guard("watchdog check", this._check()), everyMs);
    this._watchdog.unref?.();
  }

  /** Revives a session that died without an event, or a first connection that failed. */
  private async _check(): Promise<void> {
    if (this._closed) return;
    if (this._state === "disconnected" && !this._retry) {
      this._reconnect(RECONNECT_MIN_MS);
      return;
    }
    if (this._state !== "connected") return;
    const state = await within(this.client.getState());
    if (state === "CONNECTED") {
      this._strikes = 0;
      return;
    }
    if (++this._strikes < 2) return;
    this._strikes = 0;
    this._onDisconnected(`UNRESPONSIVE (${state ?? "no answer"})`);
  }

  private _render(
    message: AdapterPostableMessage,
    threadId: string,
  ): { card?: CardElement; text: string } {
    const card = extractCard(message);
    if (!card) return { text: this._converter.renderPostable(message) };
    for (const addon of this._addons("renderCard")) {
      const text = addon.renderCard!(card, this._context(threadId));
      if (text !== undefined) return { card, text };
    }
    return {
      card,
      text: this._config.richContent ? cardToText(card) : cardToPlainText(card),
    };
  }

  /** The card is already on WhatsApp, so an addon failing here must not fail the send. */
  private async _cardSent(
    card: CardElement | undefined,
    messageId: string,
    threadId: string,
  ): Promise<void> {
    if (!card) return;
    for (const addon of this._addons("cardSent")) {
      try {
        await addon.cardSent!(card, messageId, this._context(threadId));
      } catch (error) {
        this._logger.warn("An addon failed after a card was sent", { error, threadId });
      }
    }
  }

  private async _send(
    threadId: string,
    message: AdapterPostableMessage,
    options: MessageSendOptions = {},
  ): Promise<RawMessage<WAMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const { card, text: rendered } = this._render(message, threadId);
    const { mentions, text } = extractMentions(rendered);
    const media = [
      ...(await toMediaList(message, this._config.maxMediaBytes)),
      ...(await Promise.all(
        (card && this._config.richContent ? cardImages(card) : []).map((url) =>
          toMedia({ type: "image", url }, this._config.maxMediaBytes),
        ),
      )),
    ];
    const send: MessageSendOptions = {
      ...options,
      ...(mentions.length > 0 ? { mentions } : {}),
    };
    const voice = this._config.voiceNotes ?? true;

    const captionIndex = text ? media.findIndex(isCaptionable) : -1;
    const payloads: Array<[MessageContent, MessageSendOptions]> = [];
    if (media.length === 0 || (text && captionIndex === -1)) payloads.push([text, send]);
    media.forEach((item, index) => {
      const itemOptions = index === captionIndex ? { ...send, caption: text } : send;
      payloads.push([
        item,
        (voice === "ogg" ? isVoiceNote(item) : voice && isAudio(item))
          ? { ...itemOptions, sendAudioAsVoice: true }
          : itemOptions,
      ]);
    });

    let first: WAMessage | undefined;
    for (const [content, sendOptions] of payloads) {
      const sent = await this.client.sendMessage(
        chatId,
        content,
        first ? { ...sendOptions, quotedMessageId: undefined } : sendOptions,
      );
      first ??= sent;
    }
    const raw = this._raw(first, threadId);
    await this._cardSent(card, raw.id, threadId);
    return raw;
  }

  private async _sendContent(
    threadId: string,
    content: MessageContent,
    options?: MessageSendOptions,
  ): Promise<RawMessage<WAMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    return this._raw(await this.client.sendMessage(chatId, content, options), threadId);
  }

  private _raw(sent: WAMessage | undefined, threadId: string): RawMessage<WAMessage> {
    if (!sent) {
      throw new ValidationError(
        "wwebjs",
        "WhatsApp did not return the sent message. whatsapp-web.js 1.34.7 and older cannot read current WhatsApp Web; install github:pedroslopez/whatsapp-web.js#064a3d5.",
      );
    }
    return { id: sent.id._serialized, raw: sent, threadId };
  }

  private async _page(chat: WAChat, options?: FetchOptions): Promise<FetchResult<WAMessage>> {
    const limit = Math.min(MAX_HISTORY, Math.max(1, options?.limit ?? DEFAULT_LIMIT));
    // Backward cursors carry the oldest id they returned, so a message arriving between pages shifts nothing.
    const [count, before] = (options?.cursor ?? "").split("|");
    const offset = Math.min(MAX_HISTORY, Math.max(0, Number(count) || 0));
    const forward = options?.direction === "forward";

    const anchorIn = (messages: WAMessage[]) =>
      before ? messages.findIndex((message) => serialize(message.id) === before) : -1;
    let size = forward ? MAX_HISTORY : Math.min(MAX_HISTORY, offset + limit);
    let window = await chat.fetchMessages({ limit: size });
    let anchor = anchorIn(window);
    // Messages arriving since the last page push the anchor back; widen until a full page fits before it.
    while (before && !forward && anchor < limit && window.length === size && size < MAX_HISTORY) {
      size = Math.min(MAX_HISTORY, size + limit);
      window = await chat.fetchMessages({ limit: size });
      anchor = anchorIn(window);
    }
    const end = forward
      ? Math.min(window.length, offset + limit)
      : anchor >= 0
        ? anchor
        : window.length - offset;
    const start = forward ? offset : Math.max(0, end - limit);
    const page = end > start ? window.slice(start, end) : [];
    const exhausted = forward ? end >= window.length : start === 0 && window.length < size;

    return {
      messages: page.map((message) => this.parseMessage(message)),
      nextCursor:
        exhausted || page.length === 0
          ? undefined
          : forward
            ? String(end)
            : `${window.length - start}|${serialize(page[0]!.id)}`,
    };
  }

  private async _findChat(chatId: string): Promise<WAChat | null> {
    return this.client.getChatById(chatId).catch(() => null);
  }

  private async _requireChat(threadId: string): Promise<WAChat> {
    const { chatId } = this.decodeThreadId(threadId);
    const chat = await this._findChat(chatId);
    if (!chat) {
      throw new ResourceNotFoundError("wwebjs", "chat", chatId);
    }
    return chat;
  }

  /** A DM can be addressed by phone or by LID, so only a group's messages must match the thread exactly. */
  private async _findMessage(messageId: string, threadId?: string): Promise<WAMessage | null> {
    const message = await this.client.getMessageById(messageId).catch(() => null);
    if (!message || !threadId) return message;
    const chatId = chatIdOf(message);
    const expected = this.decodeThreadId(threadId).chatId;
    return chatId === expected || !(isGroupId(chatId) || isGroupId(expected)) ? message : null;
  }

  private async _requireMessage(messageId: string, threadId?: string): Promise<WAMessage> {
    const message = await this._findMessage(messageId, threadId);
    if (!message) {
      throw new ResourceNotFoundError("wwebjs", "message", messageId);
    }
    return message;
  }
}

/** Create a WhatsApp adapter backed by whatsapp-web.js. */
export function createWWebJSAdapter(config: WWebJSAdapterConfig = {}): WWebJSAdapter {
  return new WWebJSAdapter(config);
}

function chatIdOf(message: WAMessage): string {
  return message.id?.remote || (message.fromMe ? message.to : message.from);
}

/** A location's body is its map thumbnail, base64-encoded, so it reads as the place and a link instead. */
function locationText({ address, latitude, longitude, name }: WALocation): string {
  return [name, address, `https://maps.google.com/?q=${latitude},${longitude}`]
    .filter(Boolean)
    .join("\n");
}

function within<T>(lookup: Promise<T>): Promise<T | null> {
  return Promise.race([
    lookup.catch(() => null),
    new Promise<null>((resolve) => setTimeout(resolve, LOOKUP_TIMEOUT_MS, null).unref?.()),
  ]);
}

function isGroupChat(chat: WAChat | null): chat is GroupChat {
  return chat?.isGroup === true;
}

function participantAuthor(userId: string, isMe: boolean): Author {
  return { fullName: "", isBot: isMe, isMe, userId, userName: toUser(userId) };
}

function assertRange(label: string, value: number, bound: number): void {
  if (!Number.isFinite(value) || value < -bound || value > bound) {
    throw new ValidationError(
      "wwebjs",
      `sendLocation: ${label} must be between -${bound} and ${bound}. Received ${value}.`,
    );
  }
}
