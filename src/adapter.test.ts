import { ConsoleLogger, type ChatInstance, type Message } from "chat";
import { EventEmitter } from "node:events";
import type { MessageSendOptions } from "whatsapp-web.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWWebJSAdapter, WWebJSAdapter } from "./adapter";
import { isWWebJSAdapter, requireWWebJSAdapter } from "./guards";

const BOT = "15550000000@c.us";
const ALICE = "15551234567@c.us";
const GROUP = "1234567890-1234567890@g.us";
const THREAD = `wwebjs:${ALICE}`;
const GROUP_THREAD = `wwebjs:${GROUP}`;

const flush = () => new Promise((resolve) => setImmediate(resolve));

interface RawOverrides {
  [key: string]: unknown;
  body?: string;
  fromMe?: boolean;
  messageId?: string;
  remote?: string;
}

function waMessage(overrides: RawOverrides = {}) {
  const { messageId = "AAA", remote = ALICE, fromMe = false, ...rest } = overrides;
  return {
    author: undefined,
    body: "",
    from: fromMe ? BOT : remote,
    fromMe,
    hasMedia: false,
    hasQuotedMsg: false,
    id: { _serialized: `${fromMe}_${remote}_${messageId}`, fromMe, id: messageId, remote },
    links: [],
    rawData: {},
    timestamp: 1_700_000_000,
    to: fromMe ? remote : BOT,
    type: "chat",
    ...rest,
  } as never;
}

function waChat(overrides: Record<string, unknown> = {}) {
  return {
    archive: vi.fn(async () => undefined),
    clearState: vi.fn(async () => true),
    fetchMessages: vi.fn(async () => []),
    id: { _serialized: ALICE },
    isGroup: false,
    markUnread: vi.fn(async () => undefined),
    mute: vi.fn(async () => ({ isMuted: true, muteExpiration: 0 })),
    name: "Alice",
    pin: vi.fn(async () => true),
    sendSeen: vi.fn(async () => true),
    sendStateRecording: vi.fn(async () => undefined),
    sendStateTyping: vi.fn(async () => undefined),
    unarchive: vi.fn(async () => undefined),
    unmute: vi.fn(async () => ({ isMuted: false, muteExpiration: 0 })),
    unpin: vi.fn(async () => true),
    ...overrides,
  };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  return Object.assign(client, {
    destroy: vi.fn(async () => undefined),
    getChatById: vi.fn(async () => waChat()),
    getContactById: vi.fn(async () => null),
    getContactLidAndPhone: vi.fn(async () => [{ lid: undefined, pn: BOT }]),
    getMessageById: vi.fn(async () => waMessage()),
    getNumberId: vi.fn(async () => null),
    getPinnedMessages: vi.fn(async () => []),
    getProfilePicUrl: vi.fn(async () => "https://example.com/pic.jpg"),
    info: { pushname: "Bot", wid: { _serialized: BOT } },
    initialize: vi.fn(async () => undefined),
    searchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async (chatId: string, _content?: unknown, _options?: MessageSendOptions) =>
      waMessage({ fromMe: true, messageId: "SENT", remote: chatId }),
    ),
    sendPresenceAvailable: vi.fn(async () => undefined),
    sendPresenceUnavailable: vi.fn(async () => undefined),
    ...overrides,
  });
}

function fakeChatInstance() {
  return {
    getLogger: () => new ConsoleLogger("error"),
    processMemberJoinedChannel: vi.fn(),
    processMessage: vi.fn(),
    processMessageDeleted: vi.fn(),
    processMessageUpdated: vi.fn(),
    processReaction: vi.fn(),
  };
}

function setup(
  config: Record<string, unknown> = {},
  clientOverrides: Record<string, unknown> = {},
) {
  const client = fakeClient(clientOverrides);
  const adapter = createWWebJSAdapter({ client: client as never, ...config });
  const chat = fakeChatInstance();
  return { adapter, chat, client };
}

async function connected(config = {}, clientOverrides = {}) {
  const context = setup(config, clientOverrides);
  await context.adapter.initialize(context.chat as unknown as ChatInstance);
  return context;
}

describe("WWebJSAdapter", () => {
  describe("identity and thread IDs", () => {
    it("defaults its name and exposes the paired account", () => {
      const { adapter } = setup();
      expect(adapter.name).toBe("wwebjs");
      expect(adapter.userName).toBe("wwebjs-bot");
      expect(adapter.botUserId).toBe(BOT);
      expect(adapter.lockScope).toBe("channel");
    });

    it("rejects an adapter name containing a colon", () => {
      expect(() => createWWebJSAdapter({ adapterName: "wa:main" })).toThrow('":" is not allowed');
    });

    it("round-trips thread IDs", () => {
      const { adapter } = setup();
      expect(adapter.encodeThreadId({ chatId: ALICE })).toBe(THREAD);
      expect(adapter.decodeThreadId(THREAD)).toEqual({ chatId: ALICE });
    });

    it("namespaces thread IDs per account", () => {
      const sales = createWWebJSAdapter({ adapterName: "wa-sales" });
      expect(sales.encodeThreadId({ chatId: ALICE })).toBe(`wa-sales:${ALICE}`);
      expect(() => sales.decodeThreadId(THREAD)).toThrow("Invalid WhatsApp thread ID");
    });

    it("reports DMs, groups and channels", () => {
      const { adapter } = setup();
      expect(adapter.isDM(THREAD)).toBe(true);
      expect(adapter.isDM(GROUP_THREAD)).toBe(false);
      expect(adapter.getChannelVisibility(THREAD)).toBe("private");
      expect(adapter.getChannelVisibility("wwebjs:12345@newsletter")).toBe("external");
      expect(adapter.channelIdFromThreadId(THREAD)).toBe(THREAD);
    });
  });

  describe("parseMessage", () => {
    it("parses a direct message", () => {
      const { adapter } = setup();
      const parsed = adapter.parseMessage(
        waMessage({ body: "*hi* there", rawData: { notifyName: "Alice" } }),
      );
      expect(parsed.id).toBe(`false_${ALICE}_AAA`);
      expect(parsed.threadId).toBe(THREAD);
      expect(parsed.text).toBe("*hi* there");
      expect(parsed.author).toMatchObject({ fullName: "Alice", isMe: false, userId: ALICE });
      expect(parsed.metadata.dateSent.getTime()).toBe(1_700_000_000_000);
      expect(parsed.metadata.edited).toBe(false);
    });

    it("attributes a group message to its sender, not the group", () => {
      const { adapter } = setup();
      const parsed = adapter.parseMessage(waMessage({ author: ALICE, remote: GROUP }));
      expect(parsed.threadId).toBe(GROUP_THREAD);
      expect(parsed.author.userId).toBe(ALICE);
    });

    it("attributes an outgoing message to the paired account", () => {
      const { adapter } = setup();
      const parsed = adapter.parseMessage(waMessage({ fromMe: true }));
      expect(parsed.author).toMatchObject({ isBot: true, isMe: true, userId: BOT });
    });

    it("marks an edited message and carries its edit time", () => {
      const { adapter } = setup();
      const parsed = adapter.parseMessage(
        waMessage({ latestEditSenderTimestampMs: 1_700_000_500_000 }),
      );
      expect(parsed.metadata.edited).toBe(true);
      expect(parsed.metadata.editedAt?.getTime()).toBe(1_700_000_500_000);
    });

    it("describes media as an attachment that downloads on demand", async () => {
      const { adapter } = setup();
      const downloadMedia = vi.fn(async () => ({ data: Buffer.from("hello").toString("base64") }));
      const parsed = adapter.parseMessage(
        waMessage({
          body: "look",
          downloadMedia,
          hasMedia: true,
          rawData: { filename: "cat.png", mimetype: "image/png", size: 5 },
          type: "image",
        }),
      );
      const [attachment] = parsed.attachments;
      expect(attachment).toMatchObject({ mimeType: "image/png", name: "cat.png", type: "image" });
      expect(downloadMedia).not.toHaveBeenCalled();
      expect((await attachment!.fetchData!()).toString()).toBe("hello");
    });

    it("refuses to download media over the size limit, before reading it", async () => {
      const { adapter } = setup({ maxMediaBytes: 4 });
      const downloadMedia = vi.fn();
      const [attachment] = adapter.parseMessage(
        waMessage({ downloadMedia, hasMedia: true, rawData: { size: 5 }, type: "video" }),
      ).attachments;

      await expect(attachment!.fetchData!()).rejects.toThrow("over the 4-byte limit");
      expect(downloadMedia).not.toHaveBeenCalled();
    });

    it("flags a message that mentions the bot by WhatsApp ID", () => {
      const { adapter } = setup();
      expect(adapter.parseMessage(waMessage({ mentionedIds: [BOT] })).isMention).toBe(true);
      expect(
        adapter.parseMessage(waMessage({ mentionedIds: ["15559999999@c.us"] })).isMention,
      ).toBe(false);
      expect(adapter.parseMessage(waMessage()).isMention).toBe(false);
    });

    it("matches a mention across WhatsApp ID namespaces", () => {
      const { adapter } = setup();
      expect(adapter.parseMessage(waMessage({ mentionedIds: ["15550000000@lid"] })).isMention).toBe(
        true,
      );
    });

    it("recognizes a mention by the bot's LID, as WhatsApp hands it over", async () => {
      const { adapter, client } = setup(
        {},
        { getContactLidAndPhone: vi.fn(async () => [{ lid: "99887766@lid", pn: BOT }]) },
      );
      client.emit("ready");
      await flush();

      expect(
        adapter.parseMessage(waMessage({ mentionedIds: [{ $1: "99887766@lid" }] })).isMention,
      ).toBe(true);
      expect(
        adapter.parseMessage(waMessage({ mentionedIds: [{ _serialized: BOT }] })).isMention,
      ).toBe(true);
      expect(
        adapter.parseMessage(waMessage({ mentionedIds: [{ $1: "11223344@lid" }] })).isMention,
      ).toBe(false);
    });

    it("writes a mention of the bot as its name, not its LID", async () => {
      const { adapter, client } = setup(
        {},
        { getContactLidAndPhone: vi.fn(async () => [{ lid: "99887766@lid", pn: BOT }]) },
      );
      client.emit("ready");
      await flush();

      const parsed = adapter.parseMessage(
        waMessage({ body: "@99887766 hola", mentionedIds: [{ $1: "99887766@lid" }] }),
      );
      expect(parsed.text).toBe("@Bot hola");
    });

    it("carries links found in the body", () => {
      const { adapter } = setup();
      const parsed = adapter.parseMessage(
        waMessage({ links: [{ isSuspicious: false, link: "https://example.com" }] }),
      );
      expect(parsed.links).toEqual([{ url: "https://example.com" }]);
    });
  });

  describe("postMessage", () => {
    it("sends rendered text", async () => {
      const { adapter, client } = await connected();
      const sent = await adapter.postMessage(THREAD, { markdown: "**bold**" });
      expect(client.sendMessage).toHaveBeenCalledWith(ALICE, "*bold*", {});
      expect(sent).toMatchObject({ id: `true_${ALICE}_SENT`, threadId: THREAD });
    });

    it("passes mentions alongside the rewritten body", async () => {
      const { adapter, client } = await connected();
      await adapter.postMessage(GROUP_THREAD, `hey <@${ALICE}>`);
      expect(client.sendMessage).toHaveBeenCalledWith(GROUP, "hey @15551234567", {
        mentions: [ALICE],
      });
    });

    it("renders a card as fallback text", async () => {
      const { adapter, client } = await connected();
      await adapter.postMessage(THREAD, {
        card: { children: [], title: "Deploy", type: "card" } as never,
      });
      expect(String(client.sendMessage.mock.calls[0]![1])).toContain("Deploy");
    });

    it("attaches text as the caption of the first captionable media", async () => {
      const { adapter, client } = await connected();
      await adapter.postMessage(THREAD, {
        files: [{ data: Buffer.from("x"), filename: "shot.png" }],
        raw: "here you go",
      });
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      const [, media, options] = client.sendMessage.mock.calls[0]!;
      expect(media).toMatchObject({ filename: "shot.png", mimetype: "image/png" });
      expect(options).toMatchObject({ caption: "here you go" });
    });

    it("sends text separately when the only media cannot hold a caption", async () => {
      const { adapter, client } = await connected();
      await adapter.postMessage(THREAD, {
        files: [{ data: Buffer.from("x"), filename: "note.ogg" }],
        raw: "listen",
      });
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(client.sendMessage.mock.calls[0]![1]).toBe("listen");
      expect(client.sendMessage.mock.calls[1]![1]).toMatchObject({ mimetype: "audio/ogg" });
    });

    it("quotes only the first message of a multi-part send", async () => {
      const { adapter, client } = await connected();
      await adapter.reply(THREAD, "QUOTED", {
        files: [
          { data: Buffer.from("a"), filename: "a.png" },
          { data: Buffer.from("b"), filename: "b.png" },
        ],
        raw: "two shots",
      });
      expect(client.sendMessage.mock.calls[0]![2]).toMatchObject({ quotedMessageId: "QUOTED" });
      expect(client.sendMessage.mock.calls[1]![2]!.quotedMessageId).toBeUndefined();
    });

    it("sends an empty body rather than nothing when there is no content", async () => {
      const { adapter, client } = await connected();
      await adapter.postMessage(THREAD, "");
      expect(client.sendMessage).toHaveBeenCalledWith(ALICE, "", {});
    });
  });

  describe("message actions", () => {
    it("edits a message", async () => {
      const edit = vi.fn(async () => waMessage({ fromMe: true, messageId: "EDITED" }));
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => waMessage({ edit, fromMe: true })) },
      );
      const result = await adapter.editMessage(THREAD, "ID", { markdown: "**new**" });
      expect(edit).toHaveBeenCalledWith("*new*", undefined);
      expect(result.id).toBe(`true_${ALICE}_EDITED`);
    });

    it("explains why an edit was refused", async () => {
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => waMessage({ edit: vi.fn(async () => null) })) },
      );
      await expect(adapter.editMessage(THREAD, "ID", "new")).rejects.toThrow("within 15 minutes");
    });

    it("deletes for everyone", async () => {
      const remove = vi.fn(async () => undefined);
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => waMessage({ delete: remove })) },
      );
      await adapter.deleteMessage(THREAD, "ID");
      expect(remove).toHaveBeenCalledWith(true);
    });

    it("adds and removes reactions", async () => {
      const react = vi.fn(async () => undefined);
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => waMessage({ react })) },
      );
      await adapter.addReaction(THREAD, "ID", "👍");
      expect(react).toHaveBeenCalledWith("👍");
      await adapter.removeReaction(THREAD, "ID", "👍");
      expect(react).toHaveBeenLastCalledWith("");
    });

    it("reports a missing message instead of failing opaquely", async () => {
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => Promise.reject(new Error("gone"))) },
      );
      await expect(adapter.deleteMessage(THREAD, "ID")).rejects.toThrow("message");
    });
  });

  describe("fetchMessages", () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      waMessage({ body: `m${index}`, messageId: `M${index}` }),
    );
    const fetchMessages = vi.fn(async ({ limit }: { limit: number }) =>
      Number.isFinite(limit) ? history.slice(Math.max(0, history.length - limit)) : history,
    );

    beforeEach(() => {
      fetchMessages.mockClear();
    });

    it("returns the newest page in chronological order", async () => {
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => waChat({ fetchMessages })) },
      );
      const result = await adapter.fetchMessages(THREAD, { limit: 3 });
      expect(result.messages.map((message) => message.text)).toEqual(["m7", "m8", "m9"]);
      expect(result.nextCursor).toBe(`3|false_${ALICE}_M7`);
    });

    it("repeats nothing across backward pages when a message arrives in between", async () => {
      const history = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((body) =>
        waMessage({ body, messageId: body }),
      );
      const { adapter } = await connected(
        {},
        {
          getChatById: vi.fn(async () =>
            waChat({
              fetchMessages: vi.fn(async ({ limit }: { limit: number }) => history.slice(-limit)),
            }),
          ),
        },
      );
      const first = await adapter.fetchMessages(THREAD, { limit: 3 });
      history.push(waMessage({ body: "m8", messageId: "m8" }));
      const second = await adapter.fetchMessages(THREAD, { cursor: first.nextCursor, limit: 3 });

      expect(second.messages.map((message) => message.text)).toEqual(["m2", "m3", "m4"]);
    });

    it("walks backward through history with the cursor", async () => {
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => waChat({ fetchMessages })) },
      );
      const page = await adapter.fetchMessages(THREAD, { cursor: "3", limit: 3 });
      expect(page.messages.map((message) => message.text)).toEqual(["m4", "m5", "m6"]);
      expect(page.nextCursor).toBe(`6|false_${ALICE}_M4`);
    });

    it("stops when the history runs out", async () => {
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => waChat({ fetchMessages })) },
      );
      const page = await adapter.fetchMessages(THREAD, { cursor: "9", limit: 3 });
      expect(page.messages.map((message) => message.text)).toEqual(["m0"]);
      expect(page.nextCursor).toBeUndefined();
    });

    it("reads oldest first when asked to go forward", async () => {
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => waChat({ fetchMessages })) },
      );
      const first = await adapter.fetchMessages(THREAD, { direction: "forward", limit: 4 });
      expect(first.messages.map((message) => message.text)).toEqual(["m0", "m1", "m2", "m3"]);
      expect(first.nextCursor).toBe("4");

      const last = await adapter.fetchMessages(THREAD, {
        cursor: "8",
        direction: "forward",
        limit: 4,
      });
      expect(last.messages.map((message) => message.text)).toEqual(["m8", "m9"]);
      expect(last.nextCursor).toBeUndefined();
    });

    it("bounds how much history it asks WhatsApp Web for, however far the cursor reaches", async () => {
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => waChat({ fetchMessages })) },
      );
      await adapter.fetchMessages(THREAD, { direction: "forward" });
      await adapter.fetchMessages(THREAD, { cursor: "9999999", limit: 9_999_999 });

      for (const [request] of fetchMessages.mock.calls as unknown as [{ limit: number }][]) {
        expect(request.limit).toBeLessThanOrEqual(1000);
        expect(Number.isFinite(request.limit)).toBe(true);
      }
    });

    it("fetches a single message by ID and answers null when it is gone", async () => {
      const { adapter } = await connected();
      expect((await adapter.fetchMessage(THREAD, "ID"))?.threadId).toBe(THREAD);

      const { adapter: missing } = await connected(
        {},
        { getMessageById: vi.fn(async () => Promise.reject(new Error("gone"))) },
      );
      expect(await missing.fetchMessage(THREAD, "ID")).toBeNull();
    });
  });

  describe("threads, channels and users", () => {
    it("describes a DM thread", async () => {
      const { adapter } = await connected();
      expect(await adapter.fetchThread(THREAD)).toEqual({
        channelId: THREAD,
        channelName: "Alice",
        channelVisibility: "private",
        id: THREAD,
        isDM: true,
        metadata: { chatId: ALICE },
      });
    });

    it("counts members of a group channel", async () => {
      const { adapter } = await connected(
        {},
        {
          getChatById: vi.fn(async () =>
            waChat({ isGroup: true, name: "Crew", participants: [{}, {}, {}] }),
          ),
        },
      );
      expect(await adapter.fetchChannelInfo(GROUP_THREAD)).toMatchObject({
        isDM: false,
        memberCount: 3,
        name: "Crew",
      });
    });

    it("survives a chat the session has not cached", async () => {
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => Promise.reject(new Error("not found"))) },
      );
      expect((await adapter.fetchThread(THREAD)).channelName).toBeUndefined();
      await expect(adapter.markAsRead(THREAD)).rejects.toThrow("chat");
    });

    it("has no sub-threads", async () => {
      const { adapter } = await connected();
      expect(await adapter.listThreads()).toEqual({ threads: [] });
    });

    it("looks up a contact", async () => {
      const { adapter } = await connected(
        {},
        {
          getContactById: vi.fn(async () => ({
            getProfilePicUrl: async () => "https://example.com/a.jpg",
            id: { _serialized: ALICE },
            name: "Alice Smith",
            number: "15551234567",
            pushname: "alice",
          })),
        },
      );
      expect(await adapter.getUser("15551234567")).toEqual({
        avatarUrl: "https://example.com/a.jpg",
        fullName: "Alice Smith",
        isBot: false,
        userId: ALICE,
        userName: "alice",
      });
    });

    it("opens one DM for a phone number and its @c.us id", async () => {
      const { adapter } = await connected(
        {},
        { getNumberId: vi.fn(async () => ({ _serialized: "99990000111122@lid" })) },
      );
      expect(await adapter.openDM(ALICE)).toBe(await adapter.openDM("15551234567"));
    });

    it("resolves a phone number into a DM thread", async () => {
      const { adapter } = await connected(
        {},
        { getNumberId: vi.fn(async () => ({ _serialized: ALICE })) },
      );
      expect(await adapter.openDM("+1 555 123 4567")).toBe(THREAD);
    });

    it("falls back to a plain chat ID when the number cannot be resolved", async () => {
      const { adapter } = await connected();
      expect(await adapter.openDM("15551234567")).toBe(THREAD);
      expect(await adapter.openDM(GROUP)).toBe(GROUP_THREAD);
    });
  });

  describe("presence", () => {
    it("sends a read receipt", async () => {
      const chat = waChat();
      const { adapter } = await connected({}, { getChatById: vi.fn(async () => chat) });
      await adapter.markAsRead(THREAD);
      expect(chat.sendSeen).toHaveBeenCalled();
    });

    it("distinguishes typing from recording, and clears on end", async () => {
      const chat = waChat();
      const { adapter } = await connected({}, { getChatById: vi.fn(async () => chat) });
      await adapter.startTyping(THREAD);
      expect(chat.sendStateTyping).toHaveBeenCalled();
      await adapter.startTyping(THREAD, "recording");
      expect(chat.sendStateRecording).toHaveBeenCalled();
      await adapter.endTyping(THREAD);
      expect(chat.clearState).toHaveBeenCalled();
    });

    it("never fails a reply because a typing indicator could not be sent", async () => {
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => Promise.reject(new Error("not cached"))) },
      );
      await expect(adapter.startTyping(THREAD)).resolves.toBeUndefined();
      await expect(adapter.endTyping(THREAD)).resolves.toBeUndefined();
    });

    it("swallows a rejected typing call from WhatsApp itself", async () => {
      const chat = waChat({
        clearState: vi.fn(async () => Promise.reject(new Error("offline"))),
        sendStateTyping: vi.fn(async () => Promise.reject(new Error("offline"))),
      });
      const { adapter } = await connected({}, { getChatById: vi.fn(async () => chat) });
      await expect(adapter.startTyping(THREAD)).resolves.toBeUndefined();
      await expect(adapter.endTyping(THREAD)).resolves.toBeUndefined();
    });

    it("toggles the online indicator", async () => {
      const { adapter, client } = await connected();
      await adapter.setPresence("available");
      expect(client.sendPresenceAvailable).toHaveBeenCalled();
      await adapter.setPresence("unavailable");
      expect(client.sendPresenceUnavailable).toHaveBeenCalled();
    });
  });

  describe("inbound events", () => {
    it("forwards a received message to the Chat SDK", async () => {
      const { adapter, chat, client } = await connected();
      client.emit("message_create", waMessage({ body: "hello" }));
      await flush();

      expect(chat.processMessage).toHaveBeenCalledWith(adapter, THREAD, expect.any(Function));
      const factory = chat.processMessage.mock.calls[0]![2] as () => Promise<Message>;
      expect((await factory()).text).toBe("hello");
    });

    it("ignores messages the paired account sent, by default", async () => {
      const { chat, client } = await connected();
      client.emit("message_create", waMessage({ body: "mine", fromMe: true }));
      await flush();
      expect(chat.processMessage).not.toHaveBeenCalled();
    });

    it("forwards own messages when asked to", async () => {
      const { chat, client } = await connected({ receiveOwnMessages: true });
      client.emit("message_create", waMessage({ body: "mine", fromMe: true }));
      await flush();
      expect(chat.processMessage).toHaveBeenCalled();
    });

    it("resolves the quoted message into replyTo", async () => {
      const { chat, client } = await connected();
      client.emit(
        "message_create",
        waMessage({
          body: "yes",
          getQuotedMessage: async () => waMessage({ body: "ready?", messageId: "Q" }),
          hasQuotedMsg: true,
        }),
      );
      await flush();
      const factory = chat.processMessage.mock.calls[0]![2] as () => Promise<Message>;
      expect((await factory()).replyTo?.text).toBe("ready?");
    });

    it("acknowledges inbound messages when markSeen is on", async () => {
      const chat = waChat();
      const context = await connected({ markSeen: true }, { getChatById: vi.fn(async () => chat) });
      context.client.emit("message_create", waMessage());
      await flush();
      expect(chat.sendSeen).toHaveBeenCalled();
    });

    it("ignores statuses, broadcasts and WhatsApp's own notifications", async () => {
      const { chat, client } = await connected();
      client.emit("message_create", waMessage({ isStatus: true, remote: "status@broadcast" }));
      client.emit("message_create", waMessage({ remote: "123@broadcast" }));
      for (const type of ["e2e_notification", "gp2", "call_log", "protocol", "ciphertext"]) {
        client.emit("message_create", waMessage({ type }));
      }
      await flush();
      expect(chat.processMessage).not.toHaveBeenCalled();
    });

    it("writes other mentions as the contact's name, or leaves the number when unknown", async () => {
      const { chat, client } = await connected(
        {},
        {
          getContactById: vi.fn(async (id: string) =>
            id === "5551@lid" ? { name: "Ana López", pushname: "Ana" } : null,
          ),
        },
      );
      client.emit(
        "message_create",
        waMessage({
          body: "@5551 y @5552 vengan",
          mentionedIds: [{ $1: "5551@lid" }, { $1: "5552@lid" }],
          remote: GROUP,
        }),
      );
      await flush();

      const message = await chat.processMessage.mock.calls[0]![2]();
      expect(message.text).toBe("@Ana y @5552 vengan");
    });

    it("survives a handler that fails, rather than ending the process", async () => {
      const { chat, client } = await connected();
      chat.processMessage.mockImplementation(() => Promise.reject(new Error("LockError")));
      client.emit("message_create", waMessage());
      await flush();
      await flush();
      expect(chat.processMessage).toHaveBeenCalled();
    });

    it("keeps a name the sender chose literal, `$` patterns included", async () => {
      const { chat, client } = await connected(
        {},
        { getContactById: vi.fn(async () => ({ pushname: "$'$'$&" })) },
      );
      client.emit(
        "message_create",
        waMessage({ body: "@5551 tail", mentionedIds: ["5551@lid", "5551@lid"], remote: GROUP }),
      );
      await flush();

      const message = await chat.processMessage.mock.calls[0]![2]();
      expect(message.text).toBe("@$'$'$& tail");
    });

    it("names mentions whose ids share a prefix, each by its own name", async () => {
      const names: Record<string, string> = {
        "11111111111111@lid": "Bob",
        "111111111111111@lid": "Carol",
      };
      const { chat, client } = await connected(
        {},
        { getContactById: vi.fn(async (id: string) => ({ pushname: names[id] })) },
      );
      client.emit(
        "message_create",
        waMessage({
          body: "@11111111111111 and @111111111111111",
          mentionedIds: Object.keys(names),
          remote: GROUP,
        }),
      );
      await flush();

      const message = await chat.processMessage.mock.calls[0]![2]();
      expect(message.text).toBe("@Bob and @Carol");
    });

    it("still delivers a message whose mentioned contact never resolves", async () => {
      vi.useFakeTimers();
      try {
        const { chat, client } = await connected(
          {},
          { getContactById: vi.fn(() => new Promise(() => {})) },
        );
        client.emit(
          "message_create",
          waMessage({ body: "@2222 hi", mentionedIds: ["2222@lid"], remote: GROUP }),
        );
        await vi.advanceTimersByTimeAsync(0);
        const parsed = chat.processMessage.mock.calls[0]![2]();
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(parsed).resolves.toMatchObject({ text: "@2222 hi" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("looks up a bounded number of mentioned contacts", async () => {
      const getContactById = vi.fn(async () => null);
      const { chat, client } = await connected({}, { getContactById });
      client.emit(
        "message_create",
        waMessage({
          mentionedIds: Array.from({ length: 500 }, (_, index) => `${index}@lid`),
          remote: GROUP,
        }),
      );
      await flush();
      await chat.processMessage.mock.calls[0]![2]();

      expect(getContactById.mock.calls.length).toBeLessThanOrEqual(20);
    });

    it("treats a reply to one of the bot's messages as a mention", async () => {
      const { chat, client } = await connected();
      client.emit(
        "message_create",
        waMessage({
          body: "and this?",
          getQuotedMessage: vi.fn(async () => waMessage({ fromMe: true, messageId: "BOT" })),
          hasQuotedMsg: true,
          remote: GROUP,
        }),
      );
      await flush();

      const message = await chat.processMessage.mock.calls[0]![2]();
      expect(message.isMention).toBe(true);
      expect(message.replyTo.author.isMe).toBe(true);
    });

    it("ignores its own edits, deletes and reactions unless asked for them", async () => {
      const own = async (config = {}) => {
        const { chat, client } = await connected(config);
        client.emit("message_edit", waMessage({ fromMe: true }), "after", "before");
        client.emit("message_revoke_everyone", waMessage({ fromMe: true, type: "revoked" }));
        client.emit("message_reaction", {
          id: { fromMe: true, remote: ALICE },
          msgId: { $1: "M" },
          reaction: "👍",
          senderId: BOT,
        });
        await flush();
        return chat;
      };

      const ignored = await own();
      expect(ignored.processMessageUpdated).not.toHaveBeenCalled();
      expect(ignored.processMessageDeleted).not.toHaveBeenCalled();
      expect(ignored.processReaction).not.toHaveBeenCalled();

      const delivered = await own({ receiveOwnMessages: true });
      expect(delivered.processMessageUpdated).toHaveBeenCalled();
      expect(delivered.processMessageDeleted).toHaveBeenCalled();
      expect(delivered.processReaction).toHaveBeenCalled();
    });

    it("reports an edit with the body it replaced", async () => {
      const { chat, client } = await connected();
      client.emit("message_edit", waMessage({ body: "after" }), "after", "before");
      await flush();

      const event = chat.processMessageUpdated.mock.calls[0]![0];
      expect(event.threadId).toBe(THREAD);
      expect((await event.message()).text).toBe("after");
      expect((await event.previousMessage()).text).toBe("before");
    });

    it("reports the original id of a message revoked under a $1-only key", async () => {
      const { chat, client } = await connected();
      const key = { $1: `false_${ALICE}_ORIG`, fromMe: false, id: "ORIG", remote: ALICE };
      const original = waMessage({ body: "secret", messageId: "STUB" });
      (original as { id: unknown }).id = { ...key };
      client.emit(
        "message_revoke_everyone",
        waMessage({ messageId: "STUB", protocolMessageKey: key, type: "revoked" }),
        original,
      );

      const event = chat.processMessageDeleted.mock.calls[0]![0];
      expect(event.messageId).toBe(`false_${ALICE}_ORIG`);
      expect(event.previousMessage.id).toBe(`false_${ALICE}_ORIG`);
    });

    it("reports a revoked message with its previous content", async () => {
      const { chat, client } = await connected();
      client.emit(
        "message_revoke_everyone",
        waMessage({ messageId: "TOMBSTONE", type: "revoked" }),
        waMessage({ body: "oops", messageId: "ORIGINAL" }),
      );
      await flush();

      expect(chat.processMessageDeleted).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: `false_${ALICE}_ORIGINAL`,
          threadId: THREAD,
        }),
      );
      expect(chat.processMessageDeleted.mock.calls[0]![0].previousMessage.text).toBe("oops");
    });

    it("normalizes a reaction", async () => {
      const { chat, client } = await connected();
      client.emit("message_reaction", {
        id: { _serialized: "R", fromMe: false, remote: ALICE },
        msgId: { _serialized: "M" },
        reaction: "👍",
        senderId: ALICE,
      });
      await flush();

      expect(chat.processReaction).toHaveBeenCalledWith(
        expect.objectContaining({
          added: true,
          messageId: "M",
          rawEmoji: "👍",
          threadId: THREAD,
        }),
      );
      expect(chat.processReaction.mock.calls[0]![0].emoji.name).toBe("thumbs_up");
    });

    it("reads reaction IDs that WhatsApp hands over as objects", async () => {
      const { chat, client } = await connected();
      client.emit("message_reaction", {
        id: { fromMe: false, remote: { $1: ALICE } },
        msgId: { $1: "M" },
        reaction: "❤️",
        senderId: { $1: ALICE },
      });
      await flush();

      expect(chat.processReaction).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "M", threadId: THREAD }),
      );
      expect(chat.processReaction.mock.calls[0]![0].user.userId).toBe(ALICE);
    });

    it("treats an empty reaction as a removal", async () => {
      const { chat, client } = await connected();
      client.emit("message_reaction", {
        id: { _serialized: "R", fromMe: false, remote: ALICE },
        msgId: { _serialized: "M" },
        reaction: "",
        senderId: ALICE,
      });
      await flush();
      expect(chat.processReaction.mock.calls[0]![0].added).toBe(false);
    });

    it("reports delivery state changes", async () => {
      const { adapter, client } = await connected();
      const seen: unknown[] = [];
      adapter.onAck((ack) => seen.push(ack));
      client.emit("message_ack", waMessage({ fromMe: true }), 3);
      await flush();
      expect(seen[0]).toMatchObject({ status: "read", threadId: THREAD });
    });

    it("bridges a group join and reports the event", async () => {
      const { adapter, chat, client } = await connected();
      const events: unknown[] = [];
      adapter.onGroupEvent((event) => events.push(event));
      client.emit("group_join", {
        author: ALICE,
        chatId: GROUP,
        recipientIds: ["15559999999@c.us"],
      });
      await flush();

      expect(events[0]).toMatchObject({ threadId: GROUP_THREAD, type: "join" });
      expect(chat.processMemberJoinedChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: GROUP_THREAD,
          inviterId: ALICE,
          userId: "15559999999@c.us",
        }),
      );
    });

    it("reads joined members that WhatsApp hands over as objects", async () => {
      const { chat, client } = await connected();
      client.emit("group_join", {
        author: ALICE,
        chatId: GROUP,
        recipientIds: [{ $1: "15559999999@lid" }],
      });
      await flush();
      expect(chat.processMemberJoinedChannel).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "15559999999@lid" }),
      );
    });

    it("reports a group leave without bridging a join", async () => {
      const { adapter, chat, client } = await connected();
      const events: unknown[] = [];
      adapter.onGroupEvent((event) => events.push(event));
      client.emit("group_leave", { author: ALICE, chatId: GROUP, recipientIds: [ALICE] });
      await flush();
      expect(events[0]).toMatchObject({ type: "leave" });
      expect(chat.processMemberJoinedChannel).not.toHaveBeenCalled();
    });

    it("forwards incoming calls", async () => {
      const { adapter, client } = await connected();
      const calls: unknown[] = [];
      adapter.onCall((call) => calls.push(call));
      client.emit("call", { id: "CALL", isVideo: false });
      await flush();
      expect(calls).toHaveLength(1);
    });

    it("keeps dispatching after a handler throws", async () => {
      const { adapter, client } = await connected();
      const seen: unknown[] = [];
      adapter.onCall(() => {
        throw new Error("boom");
      });
      adapter.onCall((call) => seen.push(call));
      client.emit("call", { id: "CALL" });
      await flush();
      expect(seen).toHaveLength(1);
    });
  });

  describe("polls", () => {
    const vote = {
      parentMessage: waMessage({
        fromMe: true,
        messageId: "POLL",
        pollName: "Lunch?",
        pollOptions: ["Tacos", "Sushi"],
      }),
      selectedOptions: [{ id: 0, name: "Tacos" }],
      voter: ALICE,
    };

    it("sends a poll", async () => {
      const { adapter, client } = await connected();
      await adapter.sendPoll({ options: ["a", "b"], question: "Pick", threadId: THREAD });
      expect(client.sendMessage.mock.calls[0]![1]).toMatchObject({
        pollName: "Pick",
        pollOptions: [
          { localId: 0, name: "a" },
          { localId: 1, name: "b" },
        ],
      });
    });

    it("rejects a poll WhatsApp would not accept", async () => {
      const { adapter } = await connected();
      await expect(
        adapter.sendPoll({ options: ["only one"], question: "Pick", threadId: THREAD }),
      ).rejects.toThrow("between 2 and 12 options");
    });

    it("decodes a vote into option names", async () => {
      const { adapter, client } = await connected();
      const votes: unknown[] = [];
      adapter.onPollVote((event) => votes.push(event));
      client.emit("vote_update", vote);
      await flush();

      expect(votes[0]).toMatchObject({
        options: ["Tacos", "Sushi"],
        pollMessageId: `true_${ALICE}_POLL`,
        question: "Lunch?",
        selectedOptions: ["Tacos"],
        threadId: THREAD,
        voter: { userId: ALICE },
      });
    });

    it("ignores votes on polls it cannot load or did not send", async () => {
      const { adapter, client } = await connected();
      const votes: unknown[] = [];
      adapter.onPollVote((poll) => votes.push(poll));
      client.emit("vote_update", { ...vote, parentMessage: null });
      client.emit("vote_update", { ...vote, parentMessage: {} });
      client.emit("vote_update", {
        ...vote,
        parentMessage: waMessage({ fromMe: false, messageId: "THEIRS", pollOptions: [] }),
      });
      await flush();
      expect(votes).toEqual([]);
    });

    it("only fires handlers scoped to the poll that was voted on", async () => {
      const { adapter, client } = await connected();
      const matching: unknown[] = [];
      const other: unknown[] = [];
      adapter.onPollVote(`true_${ALICE}_POLL`, (event) => matching.push(event));
      adapter.onPollVote("some-other-poll", (event) => other.push(event));
      client.emit("vote_update", vote);
      await flush();

      expect(matching).toHaveLength(1);
      expect(other).toHaveLength(0);
    });

    it("requires a handler when filtering", async () => {
      const { adapter } = await connected();
      expect(() => adapter.onPollVote("poll-id", undefined as never)).toThrow(
        "handler is required",
      );
    });
  });

  describe("WhatsApp extras", () => {
    it("sends a location pin", async () => {
      const { adapter, client } = await connected();
      await adapter.sendLocation({
        address: "CA",
        latitude: 37.7749,
        longitude: -122.4194,
        name: "SF",
        threadId: THREAD,
      });
      expect(client.sendMessage.mock.calls[0]![1]).toMatchObject({
        latitude: 37.7749,
        longitude: -122.4194,
      });
    });

    it("rejects impossible coordinates", async () => {
      const { adapter } = await connected();
      await expect(
        adapter.sendLocation({ latitude: 91, longitude: 0, threadId: THREAD }),
      ).rejects.toThrow("latitude must be between -90 and 90");
      await expect(
        adapter.sendLocation({ latitude: 0, longitude: 181, threadId: THREAD }),
      ).rejects.toThrow("longitude must be between -180 and 180");
    });

    it("sends a scheduled event", async () => {
      const { adapter, client } = await connected();
      await adapter.sendEvent({
        name: "Standup",
        startTime: new Date("2026-01-01T09:00:00Z"),
        threadId: THREAD,
      });
      expect(client.sendMessage.mock.calls[0]![1]).toMatchObject({ name: "Standup" });
    });

    it("attaches no call link unless one is asked for, which WhatsApp can no longer generate", async () => {
      const { adapter, client } = await connected();
      await adapter.sendEvent({ name: "Standup", startTime: new Date(), threadId: THREAD });
      await adapter.sendEvent({
        callType: "video",
        name: "Standup",
        startTime: new Date(),
        threadId: THREAD,
      });

      const [plain, video] = client.sendMessage.mock.calls.map((call) => call[1] as never);
      expect(plain).toMatchObject({ eventSendOptions: { callType: "none" } });
      expect(video).toMatchObject({ eventSendOptions: { callType: "video" } });
    });

    it("sends an image as a sticker", async () => {
      const { adapter, client } = await connected();
      await adapter.sendSticker(THREAD, { data: Buffer.from("x"), filename: "face.webp" });
      expect(client.sendMessage.mock.calls[0]![2]).toMatchObject({ sendMediaAsSticker: true });
    });

    it("lists group participants with their roles", async () => {
      const { adapter } = await connected(
        {},
        {
          getChatById: vi.fn(async () =>
            waChat({
              isGroup: true,
              participants: [
                { id: { _serialized: ALICE }, isAdmin: false, isSuperAdmin: false },
                { id: { _serialized: BOT }, isAdmin: false, isSuperAdmin: true },
              ],
            }),
          ),
        },
      );
      expect(await adapter.fetchGroupParticipants(GROUP_THREAD)).toEqual([
        { isAdmin: false, isSuperAdmin: false, userId: ALICE },
        { isAdmin: true, isSuperAdmin: true, userId: BOT },
      ]);
    });

    it("refuses to list participants of a DM", async () => {
      const { adapter } = await connected();
      await expect(adapter.fetchGroupParticipants(THREAD)).rejects.toThrow("not a group");
    });

    it("forwards a message into another thread", async () => {
      const forward = vi.fn(async () => undefined);
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => waMessage({ forward })) },
      );
      await adapter.forwardMessage("ID", GROUP_THREAD);
      expect(forward).toHaveBeenCalledWith(GROUP);
    });

    it("scopes a message search to one thread", async () => {
      const { adapter, client } = await connected();
      await adapter.searchMessages("invoice", { limit: 5, threadId: THREAD });
      expect(client.searchMessages).toHaveBeenCalledWith("invoice", {
        chatId: ALICE,
        limit: 5,
        page: undefined,
      });
    });

    it("manages chat state", async () => {
      const chat = waChat();
      const { adapter } = await connected({}, { getChatById: vi.fn(async () => chat) });
      await adapter.markAsUnread(THREAD);
      await adapter.archiveThread(THREAD);
      await adapter.unarchiveThread(THREAD);
      await adapter.muteThread(THREAD);
      await adapter.unmuteThread(THREAD);
      expect(chat.markUnread).toHaveBeenCalled();
      expect(chat.archive).toHaveBeenCalled();
      expect(chat.unarchive).toHaveBeenCalled();
      expect(chat.mute).toHaveBeenCalledWith(undefined);
      expect(chat.unmute).toHaveBeenCalled();
    });
  });

  describe("lifecycle", () => {
    it("resolves connect once WhatsApp is ready, and only connects once", async () => {
      const { adapter, client } = await connected();
      const first = adapter.connect();
      client.emit("ready");
      await first;
      await adapter.connect();
      expect(client.initialize).toHaveBeenCalledTimes(1);
    });

    it("rejects connect when authentication fails", async () => {
      const { adapter, client } = await connected();
      const attempt = adapter.connect();
      client.emit("auth_failure", "bad session");
      await expect(attempt).rejects.toThrow("bad session");
    });

    it("adopts the account push name when none was configured", async () => {
      const { adapter, client } = await connected();
      client.emit("ready");
      expect(adapter.userName).toBe("Bot");
    });

    it("keeps an explicitly configured user name", async () => {
      const { adapter, client } = await connected({ userName: "support" });
      client.emit("ready");
      expect(adapter.userName).toBe("support");
    });

    it("closes the session on disconnect", async () => {
      const { adapter, client } = await connected();
      await adapter.disconnect();
      expect(client.destroy).toHaveBeenCalled();
    });

    describe("when WhatsApp drops the session", () => {
      beforeEach(() => {
        vi.useFakeTimers();
        return () => vi.useRealTimers();
      });

      it("opens it again, waiting longer after each failed attempt", async () => {
        const { client } = await connected();
        client.initialize.mockRejectedValueOnce(new Error("browser crashed"));

        client.emit("disconnected", "CONFLICT");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(client.initialize).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(9_999);
        expect(client.initialize).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(client.initialize).toHaveBeenCalledTimes(2);
      });

      it("opens it again once the browser crashes, which WhatsApp never reports", async () => {
        const browser = new EventEmitter();
        const { adapter, client } = await connected({}, { pupBrowser: browser });
        const first = adapter.connect();
        client.emit("ready");
        await first;

        browser.emit("disconnected");
        client.emit("disconnected", "CONFLICT");
        await vi.advanceTimersByTimeAsync(5_000);

        expect(client.destroy).toHaveBeenCalledTimes(1);
        expect(client.initialize).toHaveBeenCalledTimes(2);
      });

      it("does not reopen a browser closed on purpose", async () => {
        const browser = new EventEmitter();
        const { adapter, client } = await connected({}, { pupBrowser: browser });
        const first = adapter.connect();
        client.emit("ready");
        await first;

        await adapter.disconnect();
        browser.emit("disconnected");
        await vi.advanceTimersByTimeAsync(600_000);

        expect(client.initialize).toHaveBeenCalledTimes(1);
      });

      it("does not let a pending retry tear down a session opened in the meantime", async () => {
        const { adapter, client } = await connected();
        client.emit("disconnected", "CONFLICT");
        const reopened = adapter.connect();
        client.emit("ready");
        await reopened;

        await vi.advanceTimersByTimeAsync(600_000);
        expect(client.destroy).not.toHaveBeenCalled();
        expect(client.initialize).toHaveBeenCalledTimes(1);
      });

      it("closes a session that finishes opening after disconnect()", async () => {
        let opened!: () => void;
        const { adapter, client } = await connected(
          {},
          { initialize: vi.fn(() => new Promise<void>((resolve) => (opened = resolve))) },
        );
        const attempt = adapter.connect();
        await adapter.disconnect();
        opened();
        await attempt;

        expect(client.destroy).toHaveBeenCalledTimes(2);
      });

      it("never retries a logout, which needs a new pairing", async () => {
        const { client } = await connected();
        client.emit("disconnected", "LOGOUT");
        await vi.advanceTimersByTimeAsync(600_000);
        expect(client.initialize).not.toHaveBeenCalled();
      });

      it("stays closed after disconnect(), or when told not to reconnect", async () => {
        const closed = await connected();
        closed.client.emit("disconnected", "CONFLICT");
        await closed.adapter.disconnect();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(closed.client.initialize).not.toHaveBeenCalled();

        const off = await connected({ reconnect: false });
        off.client.emit("disconnected", "CONFLICT");
        await vi.advanceTimersByTimeAsync(600_000);
        expect(off.client.initialize).not.toHaveBeenCalled();
      });
    });

    it("answers 501 to webhook delivery", async () => {
      const { adapter } = setup();
      const response = await adapter.handleWebhook(new Request("https://example.com"));
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("connect()") });
    });
  });

  describe("rehydrateAttachment", () => {
    it("rebuilds the download closure from the stored message ID", async () => {
      const downloadMedia = vi.fn(async () => ({ data: Buffer.from("bytes").toString("base64") }));
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => waMessage({ downloadMedia, hasMedia: true })) },
      );
      const rebuilt = adapter.rehydrateAttachment({
        fetchMetadata: { messageId: "ID" },
        type: "image",
      });
      expect((await rebuilt.fetchData!()).toString()).toBe("bytes");
    });

    it("leaves an attachment without metadata untouched", () => {
      const { adapter } = setup();
      const attachment = { type: "image" as const, url: "https://example.com/a.png" };
      expect(adapter.rehydrateAttachment(attachment)).toBe(attachment);
    });
  });

  describe("guards", () => {
    it("recognizes the adapter directly and through a thread", () => {
      const { adapter } = setup();
      expect(isWWebJSAdapter(adapter)).toBe(true);
      expect(isWWebJSAdapter({})).toBe(false);
      expect(requireWWebJSAdapter(adapter)).toBe(adapter);
      expect(requireWWebJSAdapter({ adapter })).toBe(adapter);
    });

    it("rejects a foreign context", () => {
      expect(() => requireWWebJSAdapter({ adapter: { name: "slack" } })).toThrow(
        "does not belong to a wwebjs adapter",
      );
    });
  });

  it("is constructible without any configuration", () => {
    expect(new WWebJSAdapter({ client: fakeClient() as never })).toBeInstanceOf(WWebJSAdapter);
  });
});
