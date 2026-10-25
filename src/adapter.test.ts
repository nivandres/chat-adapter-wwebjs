import { downloadAttachment } from "@chat-adapter/shared";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  Actions,
  Button,
  Card,
  CardText,
  ConsoleLogger,
  ExternalSelect,
  Field,
  Fields,
  Image,
  LinkButton,
  Modal,
  NumberInput,
  RadioSelect,
  Select,
  SelectOption,
  Table,
  TextInput,
  type ChatInstance,
  type Message,
  type StateAdapter,
} from "chat";
import { EventEmitter } from "node:events";
import type { MessageSendOptions } from "whatsapp-web.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWWebJSAdapter, RECOMMENDED_CHROMIUM_ARGS, WWebJSAdapter } from "./adapter";
import { isWWebJSAdapter, requireWWebJSAdapter } from "./guards";
import { triggerIdOf } from "./modals";
import { numberedActions } from "./numbered-actions";
import { closeOnSignal } from "./shutdown";

vi.mock("@chat-adapter/shared", async (original) => {
  const shared = await original<typeof import("@chat-adapter/shared")>();
  return { ...shared, downloadAttachment: vi.fn(shared.downloadAttachment) };
});

const unsignal = vi.fn();
vi.mock("./shutdown", () => ({ closeOnSignal: vi.fn(() => unsignal) }));
beforeEach(() => vi.clearAllMocks());

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
    getState: vi.fn(async () => "CONNECTED"),
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

function fakeChatInstance(state: StateAdapter = createMemoryState()) {
  void state.connect();
  return {
    getLogger: () => new ConsoleLogger("error"),
    getState: () => state,
    processAction: vi.fn(),
    processModalClose: vi.fn(),
    processModalSubmit: vi.fn(
      async (_event: unknown, _contextId?: string): Promise<unknown> => undefined,
    ),
    processOptionsLoad: vi.fn(async (_event: unknown): Promise<unknown> => undefined),
    processSlashCommand: vi.fn(),
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

    it("reads a location as the place and a map link, not its thumbnail", () => {
      const { adapter } = setup();
      const parsed = adapter.parseMessage(
        waMessage({
          body: "/9j/4AAQSkZJRgABAQ",
          location: { address: "Calle 93", latitude: "4.67", longitude: "-74.05", name: "Office" },
          type: "location",
        }),
      );
      expect(parsed.text).toBe("Office\nCalle 93\nhttps://maps.google.com/?q=4.67,-74.05");
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

    it("renders a card in WhatsApp markup, with its tables monospaced", async () => {
      const { adapter, client } = await connected();
      await adapter.postMessage(
        THREAD,
        Card({
          children: [
            CardText("Shipped", { style: "bold" }),
            Fields([Field({ label: "Order", value: "#42" })]),
            Table({ headers: ["Item", "Qty"], rows: [["Tea", "2"]] }),
          ],
          title: "Receipt",
        }),
      );
      const text = String(client.sendMessage.mock.calls[0]![1]);
      expect(text).toContain("*Receipt*\n*Shipped*\n*Order:* #42\n```");
      expect(text).toMatch(/```\n.*Item.*Qty[\s\S]*Tea[\s\S]*```$/);
    });

    it("sends a card's images as media, its text as their caption", async () => {
      vi.mocked(downloadAttachment).mockImplementationOnce(async (_url, options) => {
        options.onResponse?.({ headers: { "content-type": "image/png" } } as never);
        return Buffer.from("png");
      });
      const { adapter, client } = await connected();
      await adapter.postMessage(
        THREAD,
        Card({ children: [Image({ url: "https://example.com/a.png" })], title: "Look" }),
      );
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const [, media, options] = client.sendMessage.mock.calls[0]!;
      expect(media).toMatchObject({ mimetype: "image/png" });
      expect(options).toMatchObject({ caption: "*Look*" });
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

    it("sends audio as a voice note", async () => {
      const { adapter, client } = await connected();
      await adapter.postMessage(THREAD, {
        files: [{ data: Buffer.from("x"), filename: "reply.ogg" }],
        raw: "",
      });
      expect(client.sendMessage.mock.calls[0]![2]).toMatchObject({ sendAudioAsVoice: true });
    });

    it("sends any audio as a voice note by default, and only OGG when told to", async () => {
      const mp3 = { files: [{ data: Buffer.from("x"), filename: "song.mp3" }], raw: "" };
      const all = await connected();
      await all.adapter.postMessage(THREAD, mp3);
      expect(all.client.sendMessage.mock.calls[0]![2]).toMatchObject({ sendAudioAsVoice: true });

      const ogg = await connected({ voiceNotes: "ogg" });
      await ogg.adapter.postMessage(THREAD, mp3);
      await ogg.adapter.postMessage(THREAD, {
        files: [{ data: Buffer.from("x"), filename: "note.ogg" }],
        raw: "",
      });
      expect(ogg.client.sendMessage.mock.calls[0]![2]!.sendAudioAsVoice).toBeUndefined();
      expect(ogg.client.sendMessage.mock.calls[1]![2]).toMatchObject({ sendAudioAsVoice: true });
    });

    it("sends audio as a file when voice notes are off, and other media never as voice", async () => {
      const { adapter, client } = await connected({ voiceNotes: false });
      await adapter.postMessage(THREAD, {
        files: [
          { data: Buffer.from("x"), filename: "song.mp3" },
          { data: Buffer.from("y"), filename: "shot.png" },
        ],
        raw: "",
      });
      for (const [, , options] of client.sendMessage.mock.calls) {
        expect(options!.sendAudioAsVoice).toBeUndefined();
      }
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

    it("edits a message it has only just sent, once WhatsApp accepts it", async () => {
      vi.useFakeTimers();
      try {
        const edit = vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(waMessage({ fromMe: true, messageId: "SENT" }));
        const { adapter } = await connected(
          {},
          {
            getMessageById: vi.fn(async () =>
              waMessage({ edit, fromMe: true, timestamp: Math.floor(Date.now() / 1000) }),
            ),
          },
        );
        const edited = adapter.editMessage(THREAD, "SENT", "new");
        await vi.advanceTimersByTimeAsync(250);

        await expect(edited).resolves.toMatchObject({ threadId: THREAD });
        expect(edit).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
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

    it("streams a reply as one whole message, and nothing when it is empty", async () => {
      const { adapter, client } = await connected();
      const sent = await adapter.stream(
        THREAD,
        (async function* () {
          yield "**Hel";
          yield { text: "lo**", type: "markdown_text" } as never;
        })(),
      );
      expect(client.sendMessage).toHaveBeenCalledOnce();
      expect(client.sendMessage).toHaveBeenCalledWith(ALICE, "*Hello*", {});
      expect(sent).toMatchObject({ id: `true_${ALICE}_SENT` });

      expect(await adapter.stream(THREAD, (async function* () {})())).toBeNull();
      expect(client.sendMessage).toHaveBeenCalledOnce();
    });

    it("streams by editing one message as the reply grows, when told to", async () => {
      vi.useFakeTimers();
      try {
        const edit = vi.fn(async (_text: string) => waMessage({ fromMe: true, messageId: "SENT" }));
        const { adapter, client } = await connected(
          { streaming: "edit" },
          {
            getMessageById: vi.fn(async () =>
              waMessage({ edit, fromMe: true, messageId: "SENT", timestamp: Date.now() / 1000 }),
            ),
          },
        );
        async function* reply() {
          yield "Hello";
          await vi.advanceTimersByTimeAsync(1_500);
          yield " there";
          yield ", friend";
        }
        const sent = await adapter.stream(THREAD, reply());

        expect(client.sendMessage).toHaveBeenCalledOnce();
        expect(client.sendMessage).toHaveBeenCalledWith(ALICE, "Hello", {});
        expect(edit.mock.calls.map(([text]) => text)).toEqual([
          "Hello there",
          "Hello there, friend",
        ]);
        expect(sent).toMatchObject({ id: `true_${ALICE}_SENT` });
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses to touch a group's message through another thread", async () => {
      const { adapter } = await connected(
        {},
        { getMessageById: vi.fn(async () => waMessage({ remote: GROUP })) },
      );
      await expect(adapter.deleteMessage(THREAD, "AAA")).rejects.toThrow("not found");
      expect(await adapter.fetchMessage(THREAD, "AAA")).toBeNull();
    });

    it("finds a DM's message whether the thread uses the phone or the LID", async () => {
      const remove = vi.fn(async () => undefined);
      const { adapter } = await connected(
        {},
        {
          getMessageById: vi.fn(async () =>
            waMessage({ delete: remove, remote: "99990000111122@lid" }),
          ),
        },
      );
      await adapter.deleteMessage(THREAD, "AAA");
      expect(remove).toHaveBeenCalledWith(true);
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

    it("lists a chat's own thread, since a WhatsApp chat is one conversation", async () => {
      const lastMessage = waMessage({ body: "latest" });
      const { adapter } = await connected(
        {},
        { getChatById: vi.fn(async () => waChat({ lastMessage })) },
      );
      const { threads } = await adapter.listThreads(THREAD);
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ id: THREAD, rootMessage: { text: "latest" } });
    });

    it("lists every chat for an inbox, newest first, page by page", async () => {
      const chats = ["A", "B", "C"].map((name, index) =>
        waChat({
          id: { _serialized: `1555000000${index}@c.us` },
          lastMessage: waMessage({ body: name, remote: `1555000000${index}@c.us` }),
        }),
      );
      const status = waChat({ id: { _serialized: "status@broadcast" }, lastMessage: waMessage() });
      const { adapter } = await connected({}, { getChats: vi.fn(async () => [status, ...chats]) });

      const first = await adapter.listChats({ limit: 2 });
      expect(first.threads.map(({ rootMessage }) => rootMessage.text)).toEqual(["A", "B"]);
      const second = await adapter.listChats({ cursor: first.nextCursor, limit: 2 });
      expect(second.threads.map(({ id }) => id)).toEqual(["wwebjs:15550000002@c.us"]);
      expect(second.nextCursor).toBeUndefined();
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

    it("never ends the process over an authentication failure after a start that failed", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      const { adapter, client } = await connected({ reconnect: false });
      client.initialize.mockRejectedValueOnce(new Error("browser already running"));
      await expect(adapter.connect()).rejects.toThrow("browser already running");

      client.emit("auth_failure", "session expired");
      await flush();

      process.off("unhandledRejection", unhandled);
      expect(unhandled).not.toHaveBeenCalled();
      expect(client.listenerCount("auth_failure")).toBe(0);
    });

    it("logs a QR handler that fails rather than ending the process", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      const { client } = await connected({
        onQR: vi.fn().mockRejectedValue(new Error("slack down")),
      });

      client.emit("qr", "scan me");
      await flush();

      process.off("unhandledRejection", unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });

    describe("with a client of your own", () => {
      const running = (state = "CONNECTED") => ({
        getState: vi.fn(async () => state),
        pupBrowser: Object.assign(new EventEmitter(), { isConnected: () => true }),
      });

      it("bridges a session already running, without starting it again", async () => {
        const { adapter, client } = await connected({}, running());

        await adapter.connect();

        expect(client.initialize).not.toHaveBeenCalled();
        expect(adapter.connection).toBe("connected");
        expect(adapter.userName).toBe("Bot");
        expect(adapter.client).toBe(client);
      });

      it("waits for a session still starting rather than starting it twice", async () => {
        const { adapter, client } = await connected({}, running("OPENING"));

        const attempt = adapter.connect();
        await flush();
        client.emit("ready");
        await attempt;

        expect(client.initialize).not.toHaveBeenCalled();
        expect(adapter.connection).toBe("connected");
      });

      it("runs a client that was never started, as if it had built it", async () => {
        const { adapter, client } = await connected();
        const attempt = adapter.connect();
        await vi.waitFor(() => expect(client.initialize).toHaveBeenCalledOnce());
        client.emit("ready");
        await attempt;
        expect(adapter.connection).toBe("connected");
      });

      it("runs a started client when forced to, and only bridges an unstarted one when told", async () => {
        const forced = await connected({ manageClient: true }, running());
        const attempt = forced.adapter.connect();
        await vi.waitFor(() => expect(forced.client.initialize).toHaveBeenCalledOnce());
        forced.client.emit("ready");
        await attempt;
        await forced.adapter.disconnect();
        expect(forced.client.destroy).toHaveBeenCalled();

        const bridged = await connected({ manageClient: false });
        await bridged.adapter.disconnect();
        expect(bridged.client.destroy).not.toHaveBeenCalled();
      });

      it("leaves its lifecycle to you: no reconnect, no destroy, no signals", async () => {
        const before = process.listenerCount("SIGTERM");
        const own = vi.fn();
        const { adapter, chat, client } = await connected({}, running());
        client.on("message_create", own);
        await adapter.connect();
        expect(process.listenerCount("SIGTERM")).toBe(before);

        client.emit("disconnected", "CONFLICT");
        expect(adapter.connection).toBe("disconnected");

        await adapter.disconnect();
        client.emit("message_create", waMessage({ body: "after" }));
        await flush();

        expect(client.destroy).not.toHaveBeenCalled();
        expect(client.initialize).not.toHaveBeenCalled();
        expect(chat.processMessage).not.toHaveBeenCalled();
        expect(own).toHaveBeenCalledOnce();
      });

      it("listens again when connected after a disconnect", async () => {
        const { adapter, chat, client } = await connected({}, running());
        await adapter.connect();
        await adapter.disconnect();

        await adapter.connect();
        client.emit("message_create", waMessage({ body: "back" }));

        await vi.waitFor(() => expect(chat.processMessage).toHaveBeenCalledOnce());
        expect(client.listenerCount("message_create")).toBe(1);
      });
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
        const browser = Object.assign(new EventEmitter(), { isConnected: () => false });
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
        const browser = Object.assign(new EventEmitter(), { isConnected: () => false });
        const { adapter, client } = await connected({}, { pupBrowser: browser });
        const first = adapter.connect();
        client.emit("ready");
        await first;

        await adapter.disconnect();
        browser.emit("disconnected");
        await vi.advanceTimersByTimeAsync(600_000);

        expect(client.initialize).toHaveBeenCalledTimes(1);
      });

      describe("a browser that dropped but is still running", () => {
        function browserWith(overrides: Record<string, unknown>) {
          const child = Object.assign(new EventEmitter(), {
            exitCode: null as number | null,
            kill: vi.fn(),
            pid: 4242,
            signalCode: null,
            ...overrides,
          });
          const browser = Object.assign(new EventEmitter(), {
            isConnected: () => false,
            process: () => child,
          });
          const kill = vi.spyOn(process, "kill").mockImplementation(() => {
            child.exitCode = 137;
            child.emit("exit");
            return true;
          });
          return { browser, kill };
        }

        it("is not mistaken for a crash when the adapter closes it itself", async () => {
          const { browser, kill } = browserWith({});
          const { adapter, client } = await connected(
            { watchdogIntervalMs: 30_000 },
            {
              destroy: vi.fn(async () => {
                await flush();
                browser.emit("disconnected");
              }),
              pupBrowser: browser,
            },
          );
          const first = adapter.connect();
          client.emit("ready");
          await first;
          client.getState.mockResolvedValue("UNPAIRED");

          await vi.advanceTimersByTimeAsync(60_000 + 5_000);
          client.getState.mockResolvedValue("CONNECTED");
          client.emit("ready");
          await vi.advanceTimersByTimeAsync(600_000);

          expect(client.initialize).toHaveBeenCalledTimes(2);
          expect(adapter.connection).toBe("connected");
          kill.mockRestore();
        });

        it("is ended before the session is opened again, since it keeps the profile locked", async () => {
          const { browser, kill } = browserWith({});
          const { adapter, client } = await connected({}, { pupBrowser: browser });
          const first = adapter.connect();
          client.emit("ready");
          await first;

          browser.emit("disconnected");
          await vi.advanceTimersByTimeAsync(5_000);

          expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
          expect(client.initialize).toHaveBeenCalledTimes(2);
          expect(kill.mock.invocationCallOrder[0]).toBeLessThan(
            client.initialize.mock.invocationCallOrder[1]!,
          );
          kill.mockRestore();
        });

        it("is left alone once it has exited", async () => {
          const { browser, kill } = browserWith({ exitCode: 0 });
          const { adapter, client } = await connected({}, { pupBrowser: browser });
          const first = adapter.connect();
          client.emit("ready");
          await first;

          browser.emit("disconnected");
          await vi.advanceTimersByTimeAsync(5_000);

          expect(kill).not.toHaveBeenCalled();
          kill.mockRestore();
        });

        it("is ended when the adapter disconnects", async () => {
          const { browser, kill } = browserWith({});
          const { adapter, client } = await connected({}, { pupBrowser: browser });
          const first = adapter.connect();
          client.emit("ready");
          await first;

          await adapter.disconnect();

          expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
          kill.mockRestore();
        });
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

      it("reports where the session stands, for health checks", async () => {
        const { adapter, client } = await connected();
        expect(adapter.connection).toBe("idle");

        const attempt = adapter.connect();
        await vi.advanceTimersByTimeAsync(0);
        expect(adapter.connection).toBe("connecting");
        client.emit("ready");
        await attempt;
        expect(adapter.connection).toBe("connected");

        client.emit("disconnected", "CONFLICT");
        expect(adapter.connection).toBe("reconnecting");
        client.emit("disconnected", "LOGOUT");
        expect(adapter.connection).toBe("logged_out");

        await adapter.disconnect();
        expect(adapter.connection).toBe("closed");
      });

      it("abandons a connection that never becomes ready, closing its browser", async () => {
        const { adapter, client } = await connected(
          { connectTimeoutMs: 10_000, reconnect: false },
          { initialize: vi.fn(() => new Promise(() => {})) },
        );
        const attempt = adapter.connect();
        const outcome = expect(attempt).rejects.toThrow("not ready within 10000ms");
        await vi.advanceTimersByTimeAsync(10_000);

        await outcome;
        expect(client.destroy).toHaveBeenCalled();
        expect(adapter.connection).toBe("disconnected");
      });

      it("waits as long as it takes for a person to scan the QR", async () => {
        const { adapter, client } = await connected({ connectTimeoutMs: 10_000, reconnect: false });
        const attempt = adapter.connect();
        await vi.advanceTimersByTimeAsync(1_000);
        client.emit("qr", "scan me");
        await vi.advanceTimersByTimeAsync(600_000);
        client.emit("ready");

        await expect(attempt).resolves.toBeUndefined();
        expect(adapter.connection).toBe("connected");
      });

      it("reopens a session WhatsApp stopped answering, which no event reported", async () => {
        const { adapter, client } = await connected({ watchdogIntervalMs: 30_000 });
        const first = adapter.connect();
        client.emit("ready");
        await first;
        client.getState.mockResolvedValue("UNPAIRED");

        await vi.advanceTimersByTimeAsync(30_000);
        expect(adapter.connection).toBe("connected");
        await vi.advanceTimersByTimeAsync(30_000);
        expect(adapter.connection).toBe("reconnecting");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(client.initialize).toHaveBeenCalledTimes(2);
      });

      it("retries a first connection that failed, once the watchdog notices", async () => {
        const { adapter, client } = await connected({ connectTimeoutMs: 1_000 });
        client.initialize.mockImplementationOnce(() => new Promise(() => {}));
        const attempt = adapter.connect().catch(() => undefined);
        await vi.advanceTimersByTimeAsync(1_000);
        await attempt;
        expect(adapter.connection).toBe("disconnected");

        await vi.advanceTimersByTimeAsync(60_000 + 5_000);
        expect(client.initialize).toHaveBeenCalledTimes(2);
      });

      it("never probes when the watchdog is off", async () => {
        const { adapter, client } = await connected({ watchdogIntervalMs: false });
        const first = adapter.connect();
        client.emit("ready");
        await first;
        await vi.advanceTimersByTimeAsync(600_000);
        expect(client.getState).not.toHaveBeenCalled();
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

  describe("catching up after the session was down", () => {
    const T = 1_700_000_000;
    const seenKey = "wwebjs:wwebjs:seen";

    async function readyWith(
      seen: { at: number; ids: string[] } | undefined,
      messages: unknown[],
      config: Record<string, unknown> = {},
    ) {
      const state = createMemoryState();
      await state.connect();
      if (seen) await state.set(seenKey, seen);
      const chat = fakeChatInstance(state);
      const fetchMessages = vi.fn(async () => messages);
      const client = fakeClient({
        getChats: vi.fn(async () => [
          waChat({ fetchMessages, timestamp: Math.floor(Date.now() / 1000) }),
        ]),
      });
      const adapter = createWWebJSAdapter({ client: client as never, ...config });
      await adapter.initialize(chat as unknown as ChatInstance);
      client.emit("ready");
      await vi.waitFor(() => expect(state.get(seenKey)).resolves.toBeTruthy());
      await flush();
      await flush();
      const delivered = async () =>
        Promise.all(
          chat.processMessage.mock.calls.map(
            async ([, , message]) => (await (message as () => Promise<Message>)()).text,
          ),
        );
      return { adapter, chat, client, delivered, state };
    }

    it("delivers what arrived since the last message, in order and each once", async () => {
      const { delivered } = await readyWith(
        { at: T, ids: [`false_${ALICE}_A`] },
        [
          waMessage({ body: "already seen", messageId: "A", timestamp: T }),
          waMessage({ body: "same second", messageId: "B", timestamp: T }),
          waMessage({ body: "later", messageId: "C", timestamp: T + 5 }),
          waMessage({ body: "mine", fromMe: true, messageId: "D", timestamp: T + 6 }),
        ],
        { catchUpMs: Number.MAX_SAFE_INTEGER },
      );

      await vi.waitFor(async () => expect(await delivered()).toEqual(["same second", "later"]));
    });

    it("gathers what every chat missed, oldest first, past a chat or a handler that fails", async () => {
      const state = createMemoryState();
      await state.connect();
      await state.set(seenKey, { at: T, ids: [] });
      const chat = fakeChatInstance(state);
      chat.processMessage.mockRejectedValueOnce(new Error("handler down"));
      const now = Math.floor(Date.now() / 1000);
      const inbox = (remote: string, ...messages: unknown[]) =>
        waChat({
          fetchMessages: vi.fn(async () => messages),
          id: { _serialized: remote },
          timestamp: now,
        });
      const client = fakeClient({
        getChats: vi.fn(async () => [
          inbox(ALICE, waMessage({ body: "third", messageId: "C", timestamp: T + 9 })),
          waChat({
            fetchMessages: vi.fn().mockRejectedValue(new Error("newsletter")),
            timestamp: now,
          }),
          inbox(
            GROUP,
            waMessage({ body: "first", messageId: "A", remote: GROUP, timestamp: T + 1 }),
            waMessage({ body: "second", messageId: "B", remote: GROUP, timestamp: T + 2 }),
          ),
        ]),
      });
      const adapter = createWWebJSAdapter({
        catchUpMs: Number.MAX_SAFE_INTEGER,
        client: client as never,
      });
      await adapter.initialize(chat as unknown as ChatInstance);
      client.emit("ready");

      await vi.waitFor(() => expect(chat.processMessage).toHaveBeenCalledTimes(3));
      const order = chat.processMessage.mock.calls.map(([, , message]) => message);
      expect(
        await Promise.all(
          order.map(async (message) => (await (message as () => Promise<Message>)()).text),
        ),
      ).toEqual(["first", "second", "third"]);
      await vi.waitFor(async () => expect(await state.get(seenKey)).toMatchObject({ at: T + 9 }));
    });

    it("handles a message once when it arrives live and is caught up too", async () => {
      const late = waMessage({ body: "both", messageId: "L", timestamp: T + 3 });
      const { chat, client } = await readyWith({ at: T, ids: [] }, [late], {
        catchUpMs: Number.MAX_SAFE_INTEGER,
      });
      client.emit("message_create", late);
      await flush();
      expect(chat.processMessage).toHaveBeenCalledOnce();
    });

    it("discards a position recorded for another number, as after pairing a new one", async () => {
      const { client, state } = await readyWith(
        { at: T, ids: [], wid: "15559999999@c.us" } as never,
        [waMessage({ body: "not mine", messageId: "X", timestamp: T + 1 })],
      );
      expect(client.getChats).not.toHaveBeenCalled();
      expect(await state.get(seenKey)).toMatchObject({ ids: [], wid: BOT });
    });

    it("says so when it could catch up on only part of what was missed", async () => {
      const warn = vi.spyOn(ConsoleLogger.prototype, "warn");
      const many = Array.from({ length: 50 }, (_, index) =>
        waMessage({ messageId: `M${index}`, timestamp: T + 1 + index }),
      );
      await readyWith({ at: T, ids: [] }, many, { catchUpMs: Number.MAX_SAFE_INTEGER });
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("older ones were missed")),
      );
      warn.mockRestore();
    });

    it("starts counting on the first run, replaying nothing from before", async () => {
      const { chat, client, state } = await readyWith(undefined, []);
      expect(client.getChats).not.toHaveBeenCalled();
      expect(chat.processMessage).not.toHaveBeenCalled();
      expect(await state.get(seenKey)).toMatchObject({ ids: [] });
    });

    it("records each message delivered, so the next restart starts after it", async () => {
      const { client, state } = await readyWith({ at: T, ids: [] }, [], {
        catchUpMs: Number.MAX_SAFE_INTEGER,
      });
      client.emit("message_create", waMessage({ body: "new", messageId: "N", timestamp: T + 99 }));
      await vi.waitFor(async () =>
        expect(await state.get(seenKey)).toEqual({
          at: T + 99,
          ids: [`false_${ALICE}_N`],
          wid: BOT,
        }),
      );
    });

    it("skips what is older than catchUpMs, and everything when it is off", async () => {
      const now = Math.floor(Date.now() / 1000);
      const old = await readyWith(
        { at: now - 7200, ids: [] },
        [
          waMessage({ body: "too old", messageId: "O", timestamp: now - 3600 }),
          waMessage({ body: "recent", messageId: "R", timestamp: now - 60 }),
        ],
        { catchUpMs: 1_800_000 },
      );
      await vi.waitFor(async () => expect(await old.delivered()).toEqual(["recent"]));

      const state = createMemoryState();
      await state.connect();
      const client = fakeClient({ getChats: vi.fn(async () => []) });
      const adapter = createWWebJSAdapter({ catchUpMs: false, client: client as never });
      await adapter.initialize(fakeChatInstance(state) as unknown as ChatInstance);
      client.emit("ready");
      await flush();
      expect(client.getChats).not.toHaveBeenCalled();
    });
  });

  describe("process signals and Chromium", () => {
    it("closes its session on a signal while connected, and stops listening once closed", async () => {
      const { adapter, client } = await connected();
      void adapter.connect();
      expect(closeOnSignal).toHaveBeenCalledOnce();
      await vi.mocked(closeOnSignal).mock.calls[0]![0]();
      expect(client.destroy).toHaveBeenCalled();

      void adapter.connect();
      await adapter.disconnect();
      expect(unsignal).toHaveBeenCalled();
    });

    it("leaves signals alone when told not to", async () => {
      const { adapter } = await connected({ handleSignals: false });
      void adapter.connect();
      expect(closeOnSignal).not.toHaveBeenCalled();
    });

    it("starts Chromium with the recommended flags, its own after them, and Puppeteer's signal handling off", () => {
      const adapter = createWWebJSAdapter({
        clientOptions: { puppeteer: { args: ["--disable-gpu=false"], headless: true } },
      });
      const { puppeteer } = (
        adapter.client as unknown as { options: { puppeteer: Record<string, unknown> } }
      ).options;
      expect(puppeteer).toMatchObject({
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        headless: true,
      });
      expect(puppeteer.args).toEqual([...RECOMMENDED_CHROMIUM_ARGS, "--disable-gpu=false"]);
    });

    it("leaves Chromium's flags and Puppeteer's signals alone when asked", () => {
      const adapter = createWWebJSAdapter({ handleSignals: false, recommendedArgs: false });
      const { puppeteer } = (
        adapter.client as unknown as { options: { puppeteer: Record<string, unknown> } }
      ).options;
      expect(puppeteer.args).toEqual([]);
      expect(puppeteer.handleSIGTERM).toBeUndefined();
    });
  });

  describe("numberedActions", () => {
    const card = Card({
      children: [
        Actions([
          Button({ id: "approve", label: "Approve", value: "yes" }),
          Button({ disabled: true, id: "never", label: "Disabled" }),
          LinkButton({ label: "Docs", url: "https://example.com/docs" }),
          Select({
            id: "size",
            label: "Size",
            options: [
              SelectOption({ label: "Small", value: "s" }),
              SelectOption({ label: "Large", value: "l" }),
            ],
          }),
        ]),
      ],
      title: "Order",
    });

    async function withAddon(options = {}) {
      const context = await connected({ addons: [numberedActions(options)] });
      await context.adapter.postMessage(THREAD, card);
      return context;
    }

    it("lists a card's buttons and select options by number, keeping links as links", async () => {
      const { client } = await withAddon();
      expect(client.sendMessage.mock.calls[0]![1]).toBe(
        "*Order*\n\n1. Approve\nDocs: https://example.com/docs\n*Size*\n2. Small\n3. Large",
      );
    });

    it("turns a reply with a number or a label into the card's action, not a message", async () => {
      const { adapter, chat, client } = await withAddon();
      client.emit("message_create", waMessage({ body: " 3 ", messageId: "R1" }));
      await vi.waitFor(() => expect(chat.processAction).toHaveBeenCalledOnce());

      const byLabel = await withAddon();
      byLabel.client.emit("message_create", waMessage({ body: "approve", messageId: "R2" }));
      await vi.waitFor(() => expect(byLabel.chat.processAction).toHaveBeenCalledOnce());

      expect(chat.processAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "size",
          adapter,
          messageId: `true_${ALICE}_SENT`,
          threadId: THREAD,
          value: "l",
        }),
        undefined,
      );
      expect(byLabel.chat.processAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "approve", value: "yes" }),
        undefined,
      );
      expect(chat.processMessage).not.toHaveBeenCalled();
    });

    it("takes one pick per card, so a repeated answer runs nothing twice", async () => {
      const { chat, client } = await withAddon();
      client.emit("message_create", waMessage({ body: "1", messageId: "R1" }));
      await vi.waitFor(() => expect(chat.processAction).toHaveBeenCalledOnce());

      client.emit("message_create", waMessage({ body: "1", messageId: "R2" }));
      await vi.waitFor(() => expect(chat.processMessage).toHaveBeenCalledOnce());
      expect(chat.processAction).toHaveBeenCalledOnce();
    });

    it("ignores the bot's own messages and a reply quoting another message", async () => {
      const { chat, client } = await withAddon({ keepMessage: false });
      client.emit(
        "message_create",
        waMessage({
          body: "1",
          getQuotedMessage: async () => waMessage({ messageId: "OTHER" }),
          hasQuotedMsg: true,
          messageId: "R1",
        }),
      );
      await vi.waitFor(() => expect(chat.processMessage).toHaveBeenCalledOnce());
      expect(chat.processAction).not.toHaveBeenCalled();

      const own = await connected({ addons: [numberedActions()], receiveOwnMessages: true });
      await own.adapter.postMessage(THREAD, card);
      own.client.emit("message_create", waMessage({ body: "1", fromMe: true, messageId: "R2" }));
      await vi.waitFor(() => expect(own.chat.processMessage).toHaveBeenCalledOnce());
      expect(own.chat.processAction).not.toHaveBeenCalled();
    });

    it("delivers anything else as a message, and the pick too when asked", async () => {
      const plain = await withAddon();
      plain.client.emit("message_create", waMessage({ body: "9" }));
      await vi.waitFor(() => expect(plain.chat.processMessage).toHaveBeenCalled());
      expect(plain.chat.processAction).not.toHaveBeenCalled();

      const kept = await withAddon({ keepMessage: true });
      kept.client.emit("message_create", waMessage({ body: "1" }));
      await vi.waitFor(() => expect(kept.chat.processMessage).toHaveBeenCalled());
      expect(kept.chat.processAction).toHaveBeenCalled();
    });

    it("leaves a card without actions to the plain fallback", async () => {
      const { adapter, client } = await connected({ addons: [numberedActions()] });
      await adapter.postMessage(THREAD, Card({ title: "Just text" }));
      expect(client.sendMessage.mock.calls[0]![1]).toBe("*Just text*");
    });

    it("never fails a send because the options could not be stored", async () => {
      const state = createMemoryState();
      vi.spyOn(state, "set").mockRejectedValue(new Error("redis down"));
      const client = fakeClient();
      const adapter = createWWebJSAdapter({ addons: [numberedActions()], client: client as never });
      await adapter.initialize(fakeChatInstance(state) as unknown as ChatInstance);

      await expect(adapter.postMessage(THREAD, card)).resolves.toMatchObject({
        id: `true_${ALICE}_SENT`,
      });
    });
  });

  describe("slash commands and modals", () => {
    const say = (client: ReturnType<typeof fakeClient>, body: string, messageId: string) =>
      client.emit("message_create", waMessage({ body, messageId }));
    const lastSent = (client: ReturnType<typeof fakeClient>) =>
      String(client.sendMessage.mock.calls.at(-1)![1]);

    it("turns a declared command into onSlashCommand, and leaves any other / text a message", async () => {
      const { adapter, chat, client } = await connected({ slashCommands: ["/help"] });
      say(client, "/HELP billing  ", "C1");
      say(client, "/other thing", "C2");
      await vi.waitFor(() => expect(chat.processMessage).toHaveBeenCalledOnce());

      expect(chat.processSlashCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter,
          channelId: THREAD,
          command: "/help",
          text: "billing",
          triggerId: triggerIdOf(THREAD, ALICE),
        }),
        undefined,
      );
    });

    it("asks a modal's fields in turn and submits the answers", async () => {
      const { adapter, chat, client } = await connected();
      await adapter.openModal(
        triggerIdOf(THREAD, ALICE),
        Modal({
          callbackId: "booking",
          children: [
            TextInput({ id: "name", label: "Name" }),
            NumberInput({ id: "guests", label: "Guests", max: 8, min: 1 }),
            Select({
              id: "day",
              label: "Day",
              options: [
                SelectOption({ label: "Mon", value: "mon" }),
                SelectOption({ label: "Tue", value: "tue" }),
              ],
            }),
            TextInput({ id: "note", label: "Note", optional: true }),
          ],
          title: "Booking",
        }),
        "ctx",
      );
      expect(lastSent(client)).toContain("*Booking*");
      expect(lastSent(client)).toContain("*Name*");

      for (const [body, asked] of [
        ["Iván", "*Guests*"],
        ["20", "That doesn't fit"],
        ["3", "1. Mon\n2. Tue"],
        ["2", "Send *skip*"],
      ] as const) {
        const before = client.sendMessage.mock.calls.length;
        say(client, body, `M${before}`);
        await vi.waitFor(() => expect(client.sendMessage.mock.calls.length).toBe(before + 1));
        expect(lastSent(client)).toContain(asked);
      }
      say(client, "skip", "LAST");

      await vi.waitFor(() =>
        expect(chat.processModalSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            callbackId: "booking",
            values: { day: "tue", guests: "3", name: "Iván" },
          }),
          "ctx",
        ),
      );
      expect(chat.processMessage).not.toHaveBeenCalled();
    });

    it("asks again for the fields the handler rejects", async () => {
      const { adapter, chat, client } = await connected();
      chat.processModalSubmit.mockResolvedValueOnce({
        action: "errors",
        errors: { email: "That address bounced." },
      });
      await adapter.openModal(
        triggerIdOf(THREAD, ALICE),
        Modal({
          callbackId: "signup",
          children: [
            TextInput({ id: "name", label: "Name" }),
            TextInput({ id: "email", label: "Email" }),
          ],
          title: "Sign up",
        }),
      );
      say(client, "Ana", "A1");
      await vi.waitFor(() => expect(lastSent(client)).toContain("*Email*"));
      say(client, "ana@bad", "A2");
      await vi.waitFor(() => expect(lastSent(client)).toContain("That address bounced."));
      say(client, "ana@good.com", "A3");

      await vi.waitFor(() => expect(chat.processModalSubmit).toHaveBeenCalledTimes(2));
      expect(chat.processModalSubmit.mock.calls[1]![0]).toMatchObject({
        values: { email: "ana@good.com", name: "Ana" },
      });
    });

    it("searches an external select through onOptionsLoad, then takes a pick", async () => {
      const { adapter, chat, client } = await connected();
      chat.processOptionsLoad.mockResolvedValueOnce([
        { label: "Bogotá", value: "bog" },
        { label: "Boston", value: "bos" },
      ]);
      await adapter.openModal(
        triggerIdOf(THREAD, ALICE),
        Modal({
          callbackId: "city",
          children: [ExternalSelect({ id: "city", label: "City" })],
          title: "Where",
        }),
      );
      say(client, "bo", "S1");
      await vi.waitFor(() => expect(lastSent(client)).toContain("1. Bogotá\n2. Boston"));
      say(client, "2", "S2");

      await vi.waitFor(() =>
        expect(chat.processModalSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ values: { city: "bos" } }),
          undefined,
        ),
      );
      expect(chat.processOptionsLoad).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "city", query: "bo" }),
      );
    });

    it("stops on cancel, telling onModalClose when the modal asks to be told", async () => {
      const { adapter, chat, client } = await connected();
      await adapter.openModal(
        triggerIdOf(THREAD, ALICE),
        Modal({
          callbackId: "survey",
          children: [
            RadioSelect({
              id: "score",
              label: "Score",
              options: [SelectOption({ label: "Good", value: "good" })],
            }),
          ],
          notifyOnClose: true,
          title: "Survey",
        }),
      );
      say(client, "Cancel", "X1");

      await vi.waitFor(() =>
        expect(chat.processModalClose).toHaveBeenCalledWith(
          expect.objectContaining({ callbackId: "survey" }),
          undefined,
        ),
      );
      expect(lastSent(client)).toBe("Cancelled.");
      say(client, "after", "X2");
      await vi.waitFor(() => expect(chat.processMessage).toHaveBeenCalledOnce());
    });

    it("speaks the language it is given, and refuses a trigger it never issued", async () => {
      const { adapter, client } = await connected({
        modalTexts: { cancel: "cancelar", cancelHint: "Envía *cancelar* para parar." },
      });
      await adapter.openModal(
        triggerIdOf(THREAD, ALICE),
        Modal({ callbackId: "x", children: [TextInput({ id: "a", label: "A" })], title: "T" }),
      );
      expect(lastSent(client)).toContain("Envía *cancelar* para parar.");
      await expect(
        adapter.openModal("forged", Modal({ callbackId: "x", title: "T" })),
      ).rejects.toThrow("Not a trigger");
    });

    it("lets a numbered answer open a modal from its action", async () => {
      const { adapter, chat, client } = await connected({ addons: [numberedActions()] });
      await adapter.postMessage(
        THREAD,
        Card({ children: [Actions([Button({ id: "book", label: "Book" })])], title: "Menu" }),
      );
      say(client, "1", "N1");
      await vi.waitFor(() =>
        expect(chat.processAction).toHaveBeenCalledWith(
          expect.objectContaining({ triggerId: triggerIdOf(THREAD, ALICE) }),
          undefined,
        ),
      );
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
