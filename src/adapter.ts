import {
  cardToFallbackText,
  extractCard,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import {
  ConsoleLogger,
  defaultEmojiResolver,
  Message,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type Author,
  type ChannelInfo,
  type ChannelVisibility,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type ListThreadsResult,
  type LockScope,
  type Logger,
  type RawMessage,
  type ThreadInfo,
  type UserInfo,
  type WebhookOptions,
} from "chat";
import type {
  Chat as WAChat,
  Client,
  GroupChat,
  GroupNotification,
  Message as WAMessage,
  MessageAck,
  MessageContent,
  MessageSendOptions,
  PollVote,
  Reaction,
} from "whatsapp-web.js";
import { WWebJSFormatConverter } from "./format-converter.js";
import {
  extractMentions,
  isBroadcastId,
  isGroupId,
  isNewsletterId,
  serialize,
  toChatId,
  toUser,
} from "./jid.js";
import { download, isCaptionable, toAttachments, toMedia, toMediaList } from "./media.js";
import type {
  WWebJSAck,
  WWebJSAckHandler,
  WWebJSAckStatus,
  WWebJSAdapterConfig,
  WWebJSCallHandler,
  WWebJSGroupEvent,
  WWebJSGroupEventHandler,
  WWebJSGroupParticipant,
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
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 300_000;
const MAX_POLL_OPTIONS = 12;
const MIN_POLL_OPTIONS = 2;

interface PollVoteSubscription {
  filter?: Set<string>;
  handler: WWebJSPollVoteHandler;
}

export class WWebJSAdapter implements Adapter<WWebJSThreadId, WAMessage> {
  readonly name: string;
  readonly lockScope: LockScope = "channel";

  /** The underlying whatsapp-web.js client, for anything this adapter does not wrap. */
  readonly client: Client;

  userName: string;

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
    this._listen();
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
    this._connection ??= this._connect().catch((error: unknown) => {
      this._connection = null;
      throw error;
    });
    return this._connection;
  }

  /** Close the browser session. */
  async disconnect(): Promise<void> {
    this._closed = true;
    clearTimeout(this._retry);
    this._connection = null;
    await this.client.destroy();
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
      raw.body ?? "",
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
    const { mentions, text } = extractMentions(this._render(message));
    const target = await this._requireMessage(messageId);
    const edited = await target.edit(text, mentions.length > 0 ? { mentions } : undefined);
    if (!edited) {
      throw new ValidationError(
        "wwebjs",
        `Message ${messageId} could not be edited. WhatsApp only allows editing your own messages within 15 minutes.`,
      );
    }
    return this._raw(edited, threadId);
  }

  async deleteMessage(_threadId: string, messageId: string): Promise<void> {
    await (await this._requireMessage(messageId)).delete(true);
  }

  async addReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await (await this._requireMessage(messageId)).react(defaultEmojiResolver.toGChat(emoji));
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    await (await this._requireMessage(messageId)).react("");
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

  async fetchMessage(_threadId: string, messageId: string): Promise<Message<WAMessage> | null> {
    const message = await this.client.getMessageById(messageId).catch(() => null);
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

  /** WhatsApp conversations are flat, so a channel never contains sub-threads. */
  async listThreads(): Promise<ListThreadsResult<WAMessage>> {
    return { threads: [] };
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
    if (this._config.phoneNumber) {
      options.pairWithPhoneNumber = {
        phoneNumber: this._config.phoneNumber,
        ...options.pairWithPhoneNumber,
      };
    }
    return options;
  }

  private async _connect(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      const onReady = () => settle(resolve);
      const onFailure = (message: string) =>
        settle(() =>
          reject(new ValidationError("wwebjs", `WhatsApp authentication failed: ${message}`)),
        );
      const settle = (finish: () => void) => {
        this.client.off("ready", onReady);
        this.client.off("auth_failure", onFailure);
        finish();
      };
      this.client.on("ready", onReady);
      this.client.on("auth_failure", onFailure);
    });
    // A previous session's browser is closed first, or every reconnect would leave one running.
    if (this._initialized) await this.client.destroy().catch(() => undefined);
    this._initialized = true;
    await this.client.initialize();
    if (this._closed) {
      await this.client.destroy();
      return;
    }
    // A crashed browser ends the session without WhatsApp ever reporting a disconnect.
    this.client.pupBrowser?.once("disconnected", () => this._onDisconnected("BROWSER_CLOSED"));
    await ready;
  }

  private _listen(): void {
    const { onPairingCode, onQR } = this._config;
    if (onQR) this.client.on("qr", (qr) => void onQR(qr));
    if (onPairingCode) this.client.on("code", (code) => void onPairingCode(code));

    this.client.on("ready", () => {
      if (!this._config.userName && this.client.info?.pushname) {
        this.userName = this.client.info.pushname;
      }
      this._logger.info("WhatsApp session ready", { userId: this.botUserId });
      void this._learnLid();
    });
    this.client.on("disconnected", (reason) => this._onDisconnected(String(reason)));
    this.client.on("message_create", (message) => this._guard("message", this._onMessage(message)));
    this.client.on("message_edit", (message, _new, previous) =>
      this._onEdit(message, String(previous)),
    );
    this.client.on("message_revoke_everyone", (message, revoked) =>
      this._onRevoke(message, revoked),
    );
    this.client.on("message_reaction", (reaction) => this._onReaction(reaction));
    this.client.on("message_ack", (message, ack) => this._onAck(message, ack));
    this.client.on("vote_update", (vote) => this._guard("poll vote", this._onVote(vote)));
    this.client.on("call", (call) => void this._dispatch(this._callHandlers, call, "onCall"));
    for (const [event, type] of Object.entries(GROUP_EVENTS)) {
      this.client.on(event, (notification: GroupNotification) => this._onGroup(type, notification));
    }
  }

  private async _onMessage(raw: WAMessage): Promise<void> {
    if (!this._chat || this._isOwn(raw.fromMe)) return;
    const chatId = chatIdOf(raw);
    if (raw.isStatus || isBroadcastId(chatId) || SYSTEM_TYPES.has(raw.type)) return;

    const threadId = this.encodeThreadId({ chatId });
    if (this._config.markSeen && !raw.fromMe) {
      await this.markAsRead(threadId).catch((error) =>
        this._logger.warn("Failed to send a read receipt", { error, threadId }),
      );
    }
    await this._chat.processMessage(this, threadId, () => this._parse(raw));
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
    if (reason === "LOGOUT") {
      this._logger.error("WhatsApp logged this session out; pair it again to reconnect", {
        reason,
      });
      return;
    }
    this._logger.warn("WhatsApp disconnected", { reason });
    this._reconnect(RECONNECT_MIN_MS);
  }

  private _reconnect(delayMs: number): void {
    if (this._closed || this._config.reconnect === false) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => {
      this.connect().catch((error: unknown) => {
        this._logger.warn("Reconnecting to WhatsApp failed", { error, delayMs });
        this._reconnect(Math.min(delayMs * 2, RECONNECT_MAX_MS));
      });
    }, delayMs);
    this._retry.unref?.();
  }

  private _render(message: AdapterPostableMessage): string {
    const card = extractCard(message);
    return card
      ? cardToFallbackText(card, { boldFormat: "*" })
      : this._converter.renderPostable(message);
  }

  private async _send(
    threadId: string,
    message: AdapterPostableMessage,
    options: MessageSendOptions = {},
  ): Promise<RawMessage<WAMessage>> {
    const { chatId } = this.decodeThreadId(threadId);
    const { mentions, text } = extractMentions(this._render(message));
    const media = await toMediaList(message, this._config.maxMediaBytes);
    const send: MessageSendOptions = {
      ...options,
      ...(mentions.length > 0 ? { mentions } : {}),
    };

    const captionIndex = text ? media.findIndex(isCaptionable) : -1;
    const payloads: Array<[MessageContent, MessageSendOptions]> = [];
    if (media.length === 0 || (text && captionIndex === -1)) payloads.push([text, send]);
    media.forEach((item, index) => {
      payloads.push([item, index === captionIndex ? { ...send, caption: text } : send]);
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
    return this._raw(first, threadId);
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
      throw new ValidationError("wwebjs", "WhatsApp did not return the sent message.");
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

  private async _requireMessage(messageId: string): Promise<WAMessage> {
    const message = await this.client.getMessageById(messageId).catch(() => null);
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
