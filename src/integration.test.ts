import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { threadIdContract } from "@chat-adapter/tests";
import { Chat, type Message, type ReactionEvent, type Thread } from "chat";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWWebJSAdapter, type WWebJSAdapter } from "./index";

const BOT = "15550000000@c.us";
const ALICE = "15551234567@c.us";
const GROUP = "1234567890-1234567890@g.us";
const DM_THREAD = `wwebjs:${ALICE}`;
const GROUP_THREAD = `wwebjs:${GROUP}`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface RawOverrides {
  [key: string]: unknown;
  fromMe?: boolean;
  messageId?: string;
  remote?: string;
}

function waMessage(overrides: RawOverrides = {}) {
  const { messageId = "AAA", remote = ALICE, fromMe = false, ...rest } = overrides;
  return {
    body: "",
    from: fromMe ? BOT : remote,
    fromMe,
    hasMedia: false,
    hasQuotedMsg: false,
    id: { _serialized: `${fromMe}_${remote}_${messageId}`, fromMe, id: messageId, remote },
    links: [],
    mentionedIds: [],
    rawData: { notifyName: "Alice" },
    timestamp: 1_700_000_000,
    to: fromMe ? remote : BOT,
    type: "chat",
    ...rest,
  } as never;
}

function fakeClient() {
  return Object.assign(new EventEmitter(), {
    destroy: vi.fn(async () => undefined),
    getChatById: vi.fn(async (chatId: string) => ({
      clearState: vi.fn(async () => true),
      fetchMessages: vi.fn(async () => []),
      id: { _serialized: chatId },
      isGroup: chatId.endsWith("@g.us"),
      name: "Alice",
      sendSeen: vi.fn(async () => true),
      sendStateRecording: vi.fn(async () => undefined),
      sendStateTyping: vi.fn(async () => undefined),
    })),
    getMessageById: vi.fn(async () => waMessage({ react: vi.fn(async () => undefined) })),
    info: { pushname: "Bot", wid: { _serialized: BOT } },
    initialize: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (chatId: string) =>
      waMessage({ fromMe: true, messageId: "SENT", remote: chatId }),
    ),
  });
}

interface Harness {
  adapter: WWebJSAdapter;
  chat: Chat;
  client: ReturnType<typeof fakeClient>;
  mentions: Array<{ message: Message; thread: Thread }>;
  reactions: ReactionEvent[];
  state: MemoryStateAdapter;
  subscribed: Array<{ message: Message; thread: Thread }>;
}

async function harness(): Promise<Harness> {
  const client = fakeClient();
  const adapter = createWWebJSAdapter({ client: client as never, userName: "wwebjs-bot" });
  const state = new MemoryStateAdapter();
  const chat = new Chat({ adapters: { wwebjs: adapter }, state, userName: "wwebjs-bot" });

  const mentions: Harness["mentions"] = [];
  const subscribed: Harness["subscribed"] = [];
  const reactions: ReactionEvent[] = [];

  chat.onNewMention(async (thread, message) => {
    mentions.push({ message, thread });
    await thread.subscribe();
    await thread.post("subscribed");
  });
  chat.onSubscribedMessage((thread, message) => {
    subscribed.push({ message, thread });
  });
  chat.onReaction((event) => {
    reactions.push(event);
  });

  await chat.initialize();
  return { adapter, chat, client, mentions, reactions, state, subscribed };
}

threadIdContract({
  cases: [
    { decoded: { chatId: ALICE }, encoded: DM_THREAD },
    { decoded: { chatId: GROUP }, encoded: GROUP_THREAD },
    { decoded: { chatId: "120363000000000000@newsletter" } },
  ],
  decode: (id) => contractAdapter.decodeThreadId(id),
  encode: (decoded) => contractAdapter.encodeThreadId(decoded),
  isDM: {
    dmThreadId: DM_THREAD,
    fn: (id) => contractAdapter.isDM(id),
    nonDmThreadId: GROUP_THREAD,
  },
  name: "wwebjs",
});

const contractAdapter = createWWebJSAdapter({ client: fakeClient() as never });

describe("Chat to adapter pipeline", () => {
  let context: Harness;

  beforeEach(async () => {
    context = await harness();
  });

  it("routes a group mention to onNewMention and posts the reply back to WhatsApp", async () => {
    context.client.emit(
      "message_create",
      waMessage({ body: "@15550000000 status?", mentionedIds: [BOT], remote: GROUP }),
    );
    await settle();

    expect(context.mentions).toHaveLength(1);
    expect(context.mentions[0]!.message.isMention).toBe(true);
    expect(context.mentions[0]!.thread.id).toBe(GROUP_THREAD);
    expect(context.client.sendMessage).toHaveBeenCalledWith(GROUP, "subscribed", {});
  });

  it("detects a mention by the bot's username too", async () => {
    context.client.emit("message_create", waMessage({ body: "@wwebjs-bot hi", remote: GROUP }));
    await settle();
    expect(context.mentions).toHaveLength(1);
  });

  it("sends follow-ups in a subscribed thread to onSubscribedMessage", async () => {
    context.client.emit(
      "message_create",
      waMessage({ body: "@15550000000 hello", mentionedIds: [BOT], remote: GROUP }),
    );
    await settle();
    await expect(context.state).toBeSubscribedTo(GROUP_THREAD);

    context.client.emit(
      "message_create",
      waMessage({ body: "and another thing", messageId: "BBB", remote: GROUP }),
    );
    await settle();

    expect(context.subscribed.map(({ message }) => message.text)).toEqual(["and another thing"]);
  });

  it("treats a direct message as a mention without any @ in the body", async () => {
    context.client.emit("message_create", waMessage({ body: "hey there" }));
    await settle();

    expect(context.mentions).toHaveLength(1);
    expect(context.mentions[0]!.thread.isDM).toBe(true);
    expect(context.client.sendMessage).toHaveBeenCalledWith(ALICE, "subscribed", {});
  });

  it("never reacts to its own messages", async () => {
    context.client.emit("message_create", waMessage({ body: "@15550000000 hi", fromMe: true }));
    context.client.emit(
      "message_create",
      waMessage({ body: "bot output", fromMe: true, remote: GROUP }),
    );
    await settle();

    expect(context.mentions).toHaveLength(0);
    expect(context.subscribed).toHaveLength(0);
    expect(context.client.sendMessage).not.toHaveBeenCalled();
  });

  it("routes a reaction through onReaction with a normalized emoji", async () => {
    context.client.emit("message_reaction", {
      id: { _serialized: "R", fromMe: false, remote: ALICE },
      msgId: { _serialized: `false_${ALICE}_AAA` },
      reaction: "👍",
      senderId: ALICE,
    });
    await settle();

    expect(context.reactions).toHaveLength(1);
    expect(context.reactions[0]).toMatchObject({ added: true, threadId: DM_THREAD });
    expect(context.reactions[0]!.emoji.name).toBe("thumbs_up");
  });

  it("carries a thread's helpers through to the adapter", async () => {
    const thread = context.chat.thread(DM_THREAD);
    await thread.startTyping();
    await thread.post({ markdown: "**done**" });

    expect(context.client.sendMessage).toHaveBeenCalledWith(ALICE, "*done*", {});
  });

  it("marks a thread as read through the SDK", async () => {
    const thread = context.chat.thread(DM_THREAD);
    await expect(thread.markAsRead(`false_${ALICE}_AAA`)).resolves.not.toThrow();
  });
});
