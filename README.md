# chat-adapter-wwebjs

[![npm version](https://img.shields.io/npm/v/chat-adapter-wwebjs.svg)](https://www.npmjs.com/package/chat-adapter-wwebjs)
[![npm downloads](https://img.shields.io/npm/dm/chat-adapter-wwebjs.svg)](https://www.npmjs.com/package/chat-adapter-wwebjs)
[![license](https://img.shields.io/npm/l/chat-adapter-wwebjs.svg)](./LICENSE)

WhatsApp adapter for the [Chat SDK](https://chat-sdk.dev), backed by [whatsapp-web.js](https://wwebjs.dev).

> [!WARNING]
> whatsapp-web.js drives WhatsApp Web in a real browser. It is not an official
> WhatsApp or Meta API, it can break when WhatsApp changes its web client, and
> WhatsApp may ban numbers that automate an ordinary account. Evaluate that
> before putting it in front of users.

## Install

```bash
npm i chat-adapter-wwebjs whatsapp-web.js chat @chat-adapter/shared
```

ESM only, Node >= 20. `chat`, `@chat-adapter/shared` and `whatsapp-web.js` are peers, so you control their versions. whatsapp-web.js downloads a Chromium build through Puppeteer on install.

WhatsApp Web renamed the IDs whatsapp-web.js reads, and 1.34.7 cannot send or find chats since. Until a release carries the fix, install it from GitHub: `npm i github:pedroslopez/whatsapp-web.js#main`.

## Quick start

```ts
import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { createWWebJSAdapter } from "chat-adapter-wwebjs";
import qrcode from "qrcode-terminal";
import { LocalAuth } from "whatsapp-web.js";

const whatsapp = createWWebJSAdapter({
  adapterName: "whatsapp",
  clientOptions: { authStrategy: new LocalAuth({ dataPath: "./.wwebjs-auth" }) },
  onQR: (qr) => qrcode.generate(qr, { small: true }),
  userName: "my-bot",
});

const bot = new Chat({
  adapters: { whatsapp },
  state: new MemoryStateAdapter(),
  userName: "my-bot",
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hello ${message.author.userName}!`);
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.startTyping();
  await thread.post(`You said: ${message.text}`);
});

await bot.initialize();
await whatsapp.connect();
```

Register the adapter under the same key as its `adapterName` — that key is the thread-ID prefix the SDK resolves threads by, so `adapters: { whatsapp }` needs `adapterName: "whatsapp"`.

Register your handlers and call `bot.initialize()` **before** `whatsapp.connect()`. Messages that arrive before the SDK is initialized are dropped, and the adapter logs a warning if you connect too early.

Scan the QR with WhatsApp → **Linked devices** → **Link a device**. `LocalAuth` keeps the session on disk, so later starts skip the scan.

## Environment variables

None. This adapter takes no credentials from the environment — a WhatsApp Web session is a browser profile, not an API token. Persist it with `LocalAuth` (a directory) or `RemoteAuth` (your own store), both from `whatsapp-web.js`.

## Configuration

| Field                | Type                        | Default         | Description                                                                                                                          |
| -------------------- | --------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `adapterName`        | `string`                    | `"wwebjs"`      | Adapter identity and thread-ID prefix. Must match the key it is registered under in `Chat`, and must not contain `:`.                |
| `client`             | `Client`                    | —               | An existing whatsapp-web.js client to drive. When omitted, one is built from `clientOptions`.                                        |
| `clientOptions`      | `ClientOptions`             | `{}`            | Options for the client the adapter builds — `authStrategy`, `puppeteer`, `webVersionCache`, and so on. Ignored when `client` is set. |
| `logger`             | `Logger`                    | `ConsoleLogger` | Logger used until `Chat` hands over its own.                                                                                         |
| `markSeen`           | `boolean`                   | `false`         | Send a read receipt for every inbound message as it arrives.                                                                         |
| `maxMediaBytes`      | `number`                    | 64 MB           | Largest media read into memory, inbound or fetched from a `url`. Bytes are counted as they arrive, whatever size the sender claims.  |
| `onPairingCode`      | `(code: string) => unknown` | —               | Receives the 8-character pairing code when `phoneNumber` is set.                                                                     |
| `onQR`               | `(qr: string) => unknown`   | —               | Receives the QR string during login. Render it with `qrcode-terminal` or similar.                                                    |
| `phoneNumber`        | `string`                    | —               | Log in with a pairing code instead of a QR. E.164 without the leading `+`.                                                           |
| `receiveOwnMessages` | `boolean`                   | `false`         | Pass what the paired account did — its messages, edits, deletes and reactions — to the Chat SDK, which still skips most of its own.  |
| `reconnect`          | `boolean`                   | `true`          | Open the session again when WhatsApp drops it, backing off from 5 seconds to 5 minutes. A logout is never retried.                   |
| `userName`           | `string`                    | `"wwebjs-bot"`  | Bot display name. When unset, the account's WhatsApp push name is adopted once the session is ready.                                 |

## Platform setup

1. Install a Chromium that Puppeteer can launch. The bundled download covers most machines; on slim Linux images install the usual shared libraries, or point `clientOptions.puppeteer.executablePath` at your own browser.
2. Pick an auth strategy. `LocalAuth` stores the session in a directory; `RemoteAuth` stores it in a database you provide. Persist it — without one you re-scan on every start.
3. Start the process and link the device: scan the QR from `onQR`, or set `phoneNumber` and enter the code from `onPairingCode` under WhatsApp → **Linked devices** → **Link with phone number**.
4. Keep the process alive. This is a live browser session, not a webhook — `handleWebhook` always answers `501`.

## Features

Everything in the Chat SDK `Adapter` interface that WhatsApp can express:

| Capability          | Notes                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Post, edit, delete  | Editing is WhatsApp's own 15-minute window on your own messages; delete is for everyone.     |
| Reply               | `thread.reply()` produces a native quoted bubble.                                            |
| Fetch messages      | Real history with forward and backward pagination — see [History](#history).                 |
| Fetch a message     | By ID, via `getMessageById`.                                                                 |
| Reactions           | Send, remove, and receive, normalized to the SDK's `EmojiValue`.                             |
| Typing and presence | `startTyping()` composes, `startTyping("recording")` records, `endTyping()` clears.          |
| Read receipts       | `thread.markAsRead()`, or `markSeen: true` for every inbound message.                        |
| Attachments         | Images, video, audio, voice notes, stickers and documents, in and out, downloaded on demand. |
| Mentions            | `thread.mentionUser(id)` renders `@number` and registers the mention with WhatsApp.          |
| Threads, channels   | Metadata, group member counts, DMs opened by phone number, contact lookup.                   |
| Edits and deletes   | `onMessageUpdated` carries the body it replaced; `onMessageDeleted` carries the original.    |
| Group joins         | Bridged to `onMemberJoinedChannel`.                                                          |

WhatsApp-specific extras live on the adapter, past the shared interface:

`sendPoll` · `onPollVote` · `sendLocation` · `sendEvent` · `sendSticker` · `forwardMessage` · `pinMessage` · `starMessage` · `fetchPinnedMessages` · `searchMessages` · `fetchGroupParticipants` · `getProfilePicUrl` · `setPresence` · `markAsUnread` · `muteThread` · `archiveThread` · `pinThread` · `onCall` · `onAck` · `onGroupEvent`

```ts
import { requireWWebJSAdapter } from "chat-adapter-wwebjs";

bot.onSubscribedMessage(async (thread) => {
  const wa = requireWWebJSAdapter(thread);
  const poll = await wa.sendPoll({
    options: ["Tacos", "Sushi", "Ramen"],
    question: "Lunch?",
    threadId: thread.id,
  });
  wa.onPollVote(poll.id, (vote) => {
    console.log(`${vote.voter.userName} picked ${vote.selectedOptions.join(", ")}`);
  });
});
```

Anything not wrapped here is still reachable: `adapter.client` is the whatsapp-web.js `Client` itself.

### History

`fetchMessages` reads real WhatsApp history, so `thread.messages` and the SDK's history API work. Cursors are offsets from the newest message.

Backward (the default) asks WhatsApp for `offset + limit` messages and returns the page — cheap, and what a chat view wants. Forward loads the whole conversation and slices, because WhatsApp offers no oldest-first cursor; use it for one-off backfills, not per-request paging. Both only see what the web client has synced.

### Formatting

Markdown is converted to WhatsApp's markup: `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, fenced blocks, `>` quotes and lists. WhatsApp has no link syntax, so links render as `text (url)`, and no tables, so tables render as ASCII inside a code block. Cards fall back to text.

### Multiple accounts

Give each adapter its own `adapterName`, matching the key it is registered under. It becomes the thread-ID prefix, so `sales:…` and `support:…` never collide on one `Chat` instance.

```ts
const sales = createWWebJSAdapter({
  adapterName: "sales",
  clientOptions: { authStrategy: new LocalAuth({ clientId: "sales" }) },
});
const support = createWWebJSAdapter({
  adapterName: "support",
  clientOptions: { authStrategy: new LocalAuth({ clientId: "support" }) },
});

const bot = new Chat({ adapters: { sales, support }, state, userName: "my-bot" });
```

## Limits

- **Not a webhook adapter.** It needs a long-lived process with a browser attached. `handleWebhook` answers `501`. To split the session from your bot logic, put it behind [`chat-adapter-remote`](https://github.com/nivandres/chat-adapter-remote).
- **One session per number**, as WhatsApp Web itself allows.
- **No streaming.** WhatsApp has no streaming API, so the SDK's post-and-edit fallback applies — and each edit is a real WhatsApp edit, bounded by the 15-minute window.
- **No ephemeral messages, scheduling, or modals.** `postEphemeral` falls back to a DM; `thread.schedule()` throws.
- **No sub-threads.** A WhatsApp conversation is one flat stream, so `listThreads` is always empty and a channel is its own thread.
- **`receiveOwnMessages` includes the adapter's own sends.** Turn it on only if your handlers can tell them apart.
- **History is what the web client synced**, not WhatsApp's full server-side archive, and one read reaches back at most 1,000 messages.
- **An attachment given only by `url` is fetched from the host's network**, with a 30-second timeout and `maxMediaBytes` as its limit. Never pass one an end user chose.
- **Statuses, broadcast lists and WhatsApp's own notifications never reach your handlers.**
- **`forwardMessage` and event call links fail on current WhatsApp Web.** whatsapp-web.js still calls modules WhatsApp has renamed; both return once it catches up. `sendEvent` without `callType` attaches no link and works.
- **Messages received while the session was down are not replayed.** WhatsApp Web syncs them into history, where `fetchMessages` finds them, but no event fires for them.

## License

MIT
