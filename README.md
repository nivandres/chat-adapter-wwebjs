[![WhatsApp (whatsapp-web.js) adapter for Chat SDK](https://chat-sdk.dev/en/adapters/community/wwebjs/og)](https://chat-sdk.dev/adapters/community/wwebjs)

# chat-adapter-wwebjs

> npm package: [`chat-adapter-wwebjs`](https://www.npmjs.com/package/chat-adapter-wwebjs)

[![npm version](https://img.shields.io/npm/v/chat-adapter-wwebjs?style=flat-square&logo=npm&logoColor=white&labelColor=000&color=000)](https://www.npmjs.com/package/chat-adapter-wwebjs)
[![npm downloads](https://img.shields.io/npm/dm/chat-adapter-wwebjs?style=flat-square&labelColor=000&color=000)](https://www.npmjs.com/package/chat-adapter-wwebjs)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](./LICENSE)

WhatsApp adapter for [Chat SDK](https://chat-sdk.dev), backed by [whatsapp-web.js](https://wwebjs.dev). It links to an ordinary WhatsApp account as a device, so it reaches DMs and groups, reads real history, and edits, deletes and reacts like a person would.

Documentation: [chat-sdk.dev/adapters/community/wwebjs](https://chat-sdk.dev/adapters/community/wwebjs)

> [!WARNING]
> whatsapp-web.js drives WhatsApp Web in a real browser. It is not an official
> WhatsApp or Meta API, it can break when WhatsApp changes its web client, and
> WhatsApp may ban numbers that automate an ordinary account. Evaluate that
> before putting it in front of users. For the official API, use
> [`@chat-adapter/whatsapp`](https://chat-sdk.dev/adapters/official/whatsapp).

## Installation

```bash
pnpm add chat-adapter-wwebjs whatsapp-web.js chat @chat-adapter/shared
```

ESM only, Node >= 20. `chat`, `@chat-adapter/shared` and `whatsapp-web.js` are peers, so you control their versions. whatsapp-web.js downloads a Chromium build through Puppeteer on install.

WhatsApp Web renamed the IDs whatsapp-web.js reads, and 1.34.7 cannot send or find chats since. Until a release carries the fix, install the commit this adapter is tested against: `pnpm add github:pedroslopez/whatsapp-web.js#064a3d5`.

## Usage

```typescript
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { createWWebJSAdapter } from "chat-adapter-wwebjs";
import qrcode from "qrcode-terminal";
import { LocalAuth } from "whatsapp-web.js";

const whatsapp = createWWebJSAdapter({
  adapterName: "whatsapp",
  clientOptions: { authStrategy: new LocalAuth({ dataPath: "./.wwebjs-auth" }) },
  onQR: (qr) => qrcode.generate(qr, { small: true }),
});

const bot = new Chat({
  userName: "mybot",
  adapters: { whatsapp },
  state: createMemoryState(),
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`Hello ${message.author.userName}!`);
});

bot.onNewMention(async (thread) => {
  await thread.subscribe();
  await thread.post("Hello from WhatsApp!");
});

await bot.initialize();
await whatsapp.connect();
```

Register the adapter under the same key as its `adapterName`: that key is the thread ID prefix the SDK resolves threads by, so `adapters: { whatsapp }` needs `adapterName: "whatsapp"`.

Register your handlers and call `bot.initialize()` **before** `whatsapp.connect()`. Messages that arrive before the SDK is initialized are dropped, and the adapter logs a warning if you connect too early.

## WhatsApp setup

### 1. Run a browser

Puppeteer's bundled Chromium covers most machines. On slim Linux images install the usual shared libraries, or point `clientOptions.puppeteer.executablePath` at your own browser. Chromium starts with `RECOMMENDED_CHROMIUM_ARGS`, which keep a single WhatsApp tab lean in a container; flags in `clientOptions.puppeteer.args` come after them, so yours win.

### 2. Keep the session

Pick an auth strategy from whatsapp-web.js. `LocalAuth` stores the session in a directory, `RemoteAuth` in a store you provide. Persist it, or you scan again on every start.

### 3. Link the device

Start the process, then on the phone open WhatsApp → **Linked devices** → **Link a device** and scan the QR handed to `onQR`. To link without a camera, set `phoneNumber` and enter the code handed to `onPairingCode` under **Link with phone number**. Once a QR or code is shown, the adapter waits for it however long it takes.

### 4. Keep the process alive

This is a live browser session, not a webhook: `handleWebhook` answers `501`. A SIGTERM closes the browser and ends the process, so `docker stop` is clean. With a signal handler of your own, call `bot.shutdown()` or the adapter's `disconnect()` and exit when you are done.

## Configuration

| Option               | Default         | Description                                                                                                                                                                                                                                               |
| -------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapterName`        | `"wwebjs"`      | Adapter identity, thread ID prefix and state key prefix. Must match the key it is registered under in `Chat`, must not contain `:`, and must be unique per account when several share a `Chat` or a state store.                                          |
| `addons`             | `[]`            | Layers over how cards are sent and messages received, such as `numberedActions()`.                                                                                                                                                                        |
| `catchUpMs`          | 1 day           | Messages that arrived while the session was down are delivered once it is back, up to this old, oldest first. `false` turns it off.                                                                                                                       |
| `client`             | —               | An existing whatsapp-web.js `Client`, exposed as `adapter.client`. One already started is bridged; one never started is the adapter's to run. See [Bridging your own client](#bridging-your-own-client). When omitted, one is built from `clientOptions`. |
| `clientOptions`      | `{}`            | Options for the client the adapter builds: `authStrategy`, `puppeteer`, `webVersionCache`, and so on. Ignored when `client` is set.                                                                                                                       |
| `connectTimeoutMs`   | 2 minutes       | How long opening the session may take before it is abandoned and, with `reconnect`, tried again. Once a QR or pairing code is shown, it waits for the scan.                                                                                               |
| `handleSignals`      | `true`          | Close the session on SIGINT, SIGTERM and SIGHUP, then let the signal end the process — unless your app listens for it and shuts down itself. Closing is given 8 seconds.                                                                                  |
| `logger`             | `ConsoleLogger` | Logger used until `Chat` hands over its own.                                                                                                                                                                                                              |
| `modalTexts`         | English         | The phrases a conversational modal sends, such as its _cancel_ and _skip_ words, to put them in your users' language. See [Modals](#modals).                                                                                                              |
| `manageClient`       | by state        | Force who runs a `client` you passed: `true` has the adapter reconnect it, close it on `disconnect()` and on a signal, even if you started it; `false` only bridges it, even if you didn't.                                                               |
| `markSeen`           | `false`         | Send a read receipt for every inbound message as it arrives.                                                                                                                                                                                              |
| `maxMediaBytes`      | 64 MB           | Largest media read into memory, inbound or fetched from a `url`. The size is checked before reading and the bytes are counted as they arrive, whatever size the sender claims.                                                                            |
| `onPairingCode`      | —               | Receives the 8-character pairing code when `phoneNumber` is set.                                                                                                                                                                                          |
| `onQR`               | —               | Receives the QR string during login. Render it with `qrcode-terminal` or similar.                                                                                                                                                                         |
| `phoneNumber`        | —               | Log in with a pairing code instead of a QR. E.164 without the leading `+`.                                                                                                                                                                                |
| `receiveOwnMessages` | `false`         | Pass what the paired account did — its messages, edits, deletes and reactions — to the Chat SDK, which still skips most of its own.                                                                                                                       |
| `recommendedArgs`    | `true`          | Start Chromium with `RECOMMENDED_CHROMIUM_ARGS`: one renderer process, no GPU, no component updates.                                                                                                                                                      |
| `reconnect`          | `true`          | Open the session again when WhatsApp drops it, backing off from 5 seconds to 5 minutes. A logout is never retried.                                                                                                                                        |
| `slashCommands`      | —               | Commands, such as `"/help"`, whose messages reach `onSlashCommand`. See [Slash commands](#slash-commands).                                                                                                                                                |
| `streaming`          | `"buffer"`      | How a streamed reply goes out: `"buffer"` sends it once, whole; `"edit"` sends the first words and edits the message as the rest arrives, at most once a second.                                                                                          |
| `userName`           | `"wwebjs-bot"`  | Bot display name. When unset, the account's WhatsApp push name is adopted once the session is ready.                                                                                                                                                      |
| `voiceNotes`         | `true`          | Send audio as a voice note, played inline with a waveform: `true` for all audio, `"ogg"` for OGG/Opus only, which every phone plays as one, `false` for none.                                                                                             |
| `watchdogIntervalMs` | 1 minute        | How often a connected session is asked whether WhatsApp still answers; two failed checks count as a disconnect. `false` turns it off.                                                                                                                     |

## Environment variables

None. A WhatsApp Web session is a browser profile, not an API token, so there is nothing to put in the environment. Persist it with `LocalAuth` or `RemoteAuth` instead.

## Features

### Messaging

| Feature            | Supported                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Post message       | Yes                                                                                      |
| Message replies    | Yes (native quoted bubble)                                                               |
| Edit message       | Yes (your own messages, within WhatsApp's 15-minute window)                              |
| Delete message     | Yes (for everyone)                                                                       |
| File uploads       | Yes (images, video, audio, voice notes, documents, stickers)                             |
| Streaming          | Yes (`streaming: "buffer"` sends it once, whole; `"edit"` edits one message as it grows) |
| Scheduled messages | No                                                                                       |

### Rich content

| Feature         | Supported                                                                     |
| --------------- | ----------------------------------------------------------------------------- |
| Card format     | Yes (WhatsApp markup: bold title, `*Label:* value` fields, monospaced tables) |
| Buttons         | Partial (answered by number with [`numberedActions()`](#card-actions))        |
| Link buttons    | Partial (`Label: url` lines)                                                  |
| Select menus    | Partial (answered by number with `numberedActions()`)                         |
| Tables          | Partial (ASCII in a code block)                                               |
| Charts          | Partial (text)                                                                |
| Fields          | Partial (`Label: value` lines)                                                |
| Images in cards | Yes (sent as media, the card text as caption)                                 |
| Modals          | Partial (conversational: each field asked in turn, see [Modals](#modals))     |

### Conversations

| Feature               | Supported                                                                 |
| --------------------- | ------------------------------------------------------------------------- |
| Slash commands        | Partial (the commands you declare, see [Slash commands](#slash-commands)) |
| Mentions              | Yes (by number or LID in, `thread.mentionUser()` out)                     |
| Add reactions         | Yes                                                                       |
| Remove reactions      | Yes                                                                       |
| Typing indicator      | Yes (`startTyping()` composes, `startTyping("recording")` records)        |
| Mark as read          | Yes (the whole chat), or `markSeen` for every inbound message             |
| Message edit events   | Yes (with the body it replaced)                                           |
| Message delete events | Yes (with the original message)                                           |
| DMs                   | Yes (a phone number resolves to the chat WhatsApp uses for it)            |
| Ephemeral messages    | No (the SDK falls back to a DM)                                           |
| User lookup           | Yes (name, push name, number, profile picture)                            |
| Native client         | Yes (`adapter.client` is the whatsapp-web.js `Client`)                    |
| Group joins           | Yes (`onMemberJoinedChannel`)                                             |

### Message history

| Feature                | Supported                                                                  |
| ---------------------- | -------------------------------------------------------------------------- |
| Fetch messages         | Yes (synced history, forward and backward pagination)                      |
| Fetch single message   | Yes                                                                        |
| Fetch thread info      | Yes                                                                        |
| Fetch channel messages | Yes                                                                        |
| List threads           | Partial (a chat lists itself; `listChats()` lists every chat for an inbox) |
| Fetch channel info     | Yes (group name and member count)                                          |
| Post channel message   | Yes                                                                        |

### Incoming message types

| Type                | Supported                                  |
| ------------------- | ------------------------------------------ |
| Text                | Yes                                        |
| Images              | Yes (with captions)                        |
| Video               | Yes (with captions)                        |
| Audio / Voice notes | Yes                                        |
| Documents           | Yes (with captions)                        |
| Stickers            | Yes (as images)                            |
| Locations           | Yes (place, address and a map link)        |
| Contacts            | Partial (a single contact's vCard as text) |
| Poll votes          | Yes (`onPollVote`)                         |
| Reactions           | Yes                                        |
| Edits and deletes   | Yes                                        |

Statuses, broadcast lists and WhatsApp's own notifications never reach your handlers.

### WhatsApp extensions

Past the shared interface, the adapter carries what WhatsApp adds:

`sendPoll` · `onPollVote` · `sendLocation` · `sendEvent` · `sendSticker` · `forwardMessage` · `pinMessage` · `starMessage` · `fetchPinnedMessages` · `searchMessages` · `fetchGroupParticipants` · `getProfilePicUrl` · `setPresence` · `markAsUnread` · `muteThread` · `archiveThread` · `pinThread` · `onCall` · `onAck` · `onGroupEvent`

```typescript
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

Anything not wrapped is still reachable through `adapter.client`.

## Card actions

WhatsApp Web cannot send buttons, so a card's buttons would be dropped from its text. Add `numberedActions()` and they are listed by number instead, select options included, and a reply with a number — or a label — reaches `onAction` as a click would. Link buttons keep their URL; a button that opens a modal is left out, since WhatsApp has none.

```typescript
import { createWWebJSAdapter, numberedActions } from "chat-adapter-wwebjs";

const whatsapp = createWWebJSAdapter({ addons: [numberedActions()] });

bot.onAction("approve", async (event) => {
  await event.thread?.post(`Approved by ${event.user.userName}`);
});
```

The options of a thread's latest card answer for a day (`ttlMs`) and live in the Chat SDK state. The first pick ends them, so a repeated answer runs nothing twice; a reply quoting another message is not a pick, and neither is anything the bot's own account sends. In a group anyone can answer, and `event.user` says who did. The reply that picked an option is not delivered as a message unless `keepMessage` is set.

An addon is a plain object with optional `renderCard`, `cardSent` and `onMessage` hooks, so other layers fit the same way.

## Streaming

WhatsApp cannot stream, so `streaming` picks how a streamed reply — `thread.post(textStream)` — reaches it. `"buffer"`, the default, sends the reply once it is complete, as WhatsApp's own Cloud API adapter does. `"edit"` sends the first words, then edits that one message as the rest arrives, at most once a second, so the person watches it being written; an edit WhatsApp refuses part-way only delays the words, and the last one always lands. WhatsApp allows edits for 15 minutes, which a reply never outlasts.

## Slash commands

WhatsApp has no slash commands, so declare the ones you handle and their messages become commands:

```typescript
const whatsapp = createWWebJSAdapter({ slashCommands: ["/help", "/agent"] });

bot.onSlashCommand("/help", async (event) => {
  await event.channel.post(`Help with ${event.text || "anything"}`);
});
```

`/help billing` arrives as command `/help` with text `"billing"`, matched without regard to case. Any other text starting with `/`, such as a path or `/shrug`, stays an ordinary message. A command can open a modal with `event.openModal()`.

## Modals

WhatsApp has no modals either, so `openModal()` turns one into a conversation with the person who triggered it: the title and any text it shows, then each field in turn.

```typescript
bot.onAction("book", (event) =>
  event.openModal(
    Modal({
      callbackId: "booking",
      title: "Booking",
      children: [
        TextInput({ id: "name", label: "Name" }),
        Select({
          id: "day",
          label: "Day",
          options: [
            SelectOption({ label: "Mon", value: "mon" }),
            SelectOption({ label: "Tue", value: "tue" }),
          ],
        }),
      ],
    }),
  ),
);

bot.onModalSubmit("booking", (event) =>
  event.relatedThread?.post(`Booked for ${event.values.day}`),
);
```

| Input                   | Answered with                                                                  |
| ----------------------- | ------------------------------------------------------------------------------ |
| `TextInput`             | Any text, within `maxLength`                                                   |
| `NumberInput`           | A number, within `min` and `max`, whole unless `decimal`                       |
| `DateInput`             | A date as `YYYY-MM-DD`                                                         |
| `Select`, `RadioSelect` | An option's number or label                                                    |
| `ExternalSelect`        | Words to search, which reach `onOptionsLoad`, then a number from what it found |

An optional field, or one with an initial value, can be answered _skip_. _cancel_, or the modal's `closeLabel`, stops it, and reaches `onModalClose` when the modal sets `notifyOnClose`. An answer that doesn't fit is asked again with the reason. When every field is answered, `onModalSubmit` receives the values: return `{ action: "errors", errors }` and only those fields are asked again, with your messages; return `{ action: "update", modal }` or `{ action: "push", modal }` and the new modal starts. A modal left unanswered stops waiting after a day.

Modals open from actions — `numberedActions()` answers carry a trigger — and from slash commands. To open one for someone without either, pass `triggerIdOf(threadId, userId)` to `adapter.openModal()`. Put the phrases a modal sends in your users' language with `modalTexts`:

```typescript
createWWebJSAdapter({
  modalTexts: {
    cancel: "cancelar",
    cancelHint: "Envía *cancelar* para parar.",
    cancelled: "Cancelado.",
    invalid: "Eso no encaja. Intenta de nuevo:",
    noResults: "No encontré nada. Prueba otras palabras:",
    search: "Envía unas palabras para buscar.",
    skip: "omitir",
    skipHint: "Envía *omitir* para dejarlo como está.",
  },
});
```

## Bridging your own client

Pass a whatsapp-web.js `Client` you already run and the adapter bridges it as it is:

```typescript
const client = new Client({ authStrategy: new LocalAuth() });
client.on("message", handleItYourself);
await client.initialize();

const whatsapp = createWWebJSAdapter({ client });
await whatsapp.connect(); // already running: adopted, without starting it again
```

What the adapter does with it depends on whether it was started when you passed it:

- **Already started**, as above, it is bridged as it is. `connect()` adopts its session without a second `initialize()`, or waits for it if it is still starting. Its options and listeners are left alone, and its lifecycle stays yours: the adapter never reconnects or destroys it, nor closes it on a signal, and `disconnect()` only detaches the adapter.
- **Never started**, it is the adapter's to run, exactly as one it built: `connect()` starts it, and the adapter reconnects it, closes it on `disconnect()` and on a signal.

`manageClient` forces either way: `true` hands even a client you started to the adapter, and `false` keeps even an unstarted one a bridge, which `connect()` starts but never reconnects or closes.

## Message history

`listChats()` lists every chat the account has, newest first, each with its latest message, paged with `limit` and `cursor`: the list an inbox shows. `listThreads(channelId)` returns the chat's own thread, since a WhatsApp chat is one conversation.

`fetchMessages` reads real WhatsApp history, so `thread.messages` and the SDK's history API work. Backward cursors (the default) carry the oldest message they returned, so a message arriving between pages shifts nothing. Forward reads load the whole conversation and slice it, since WhatsApp offers no oldest-first cursor; use them for one-off backfills. Both see what the web client has synced, and one read reaches back at most 1,000 messages.

## Catching up after downtime

WhatsApp Web loads what arrived while the session was down without firing an event for each message, so the adapter catches up on its own once the session is back: it gathers what every recent chat missed, oldest first, and hands each message to your handlers. The position lives in the Chat SDK state with the account it belongs to, so a restart starts where the last process stopped, and pairing a new number starts afresh. A restart part-way through delivers again rather than skip, and a message that arrives live while it is caught up is handled once. The first run starts counting and replays nothing older. A chat outside the 100 most recent, or more than 50 messages behind, is not caught up in full, and the adapter logs a warning when that happens.

## Multiple accounts

Give each adapter its own `adapterName`, matching the key it is registered under. It prefixes thread IDs and state keys, so `sales:…` and `support:…` never collide, on one `Chat` or in one shared store.

```typescript
const sales = createWWebJSAdapter({
  adapterName: "sales",
  clientOptions: { authStrategy: new LocalAuth({ clientId: "sales" }) },
});
const support = createWWebJSAdapter({
  adapterName: "support",
  clientOptions: { authStrategy: new LocalAuth({ clientId: "support" }) },
});

const bot = new Chat({ userName: "mybot", adapters: { sales, support }, state });
```

## Running the session apart from your bot

The session needs a long-lived process with a browser, which serverless bots cannot hold. [`chat-adapter-remote`](https://github.com/nivandres/chat-adapter-remote) runs this adapter in its own process and bridges it to your bot over signed HTTP. `adapter.connection` reports where the session stands — `connected`, `reconnecting`, `logged_out` and so on — for its health check:

```typescript
serveAdapter(whatsapp, { healthy: () => whatsapp.connection === "connected" });
```

## Formatting

Markdown is converted to WhatsApp's markup: `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, fenced blocks, `>` quotes and lists. WhatsApp has no link syntax, so links render as `text (url)`, and no tables, so tables render as ASCII inside a code block.

## Thread ID format

```
{adapterName}:{chatId}
```

Examples: `wwebjs:15551234567@c.us` (DM by phone), `wwebjs:99990000111122@lid` (DM by LID), `wwebjs:1234567890-1234567890@g.us` (group). A channel is its own thread.

## Troubleshooting

### The QR never appears

- Check that Chromium can start: run locally with `clientOptions.puppeteer.headless: false`, or look for missing shared libraries on Linux.
- WhatsApp replaces the QR every 20 seconds or so; render each one `onQR` receives.

### Sends fail or chats are not found

- whatsapp-web.js 1.34.7 cannot read current WhatsApp Web. Install `github:pedroslopez/whatsapp-web.js#064a3d5`.

### "The browser is already running"

- Another process holds the same `LocalAuth` profile. The adapter ends the browser it runs before reopening; a client you started yourself is yours to close.

### The session drops

- `adapter.connection` turns `reconnecting` and the adapter reopens it with backoff. `logged_out` means the device was unlinked on the phone and needs a new scan.

## Limitations

- **Unofficial.** It automates WhatsApp Web, which WhatsApp may block or change at any time.
- **One session per number**, as WhatsApp Web itself allows.
- **No scheduling or ephemeral messages.** `postEphemeral` falls back to a DM; `thread.schedule()` throws.
- **`receiveOwnMessages` includes the adapter's own sends.** Turn it on only if your handlers can tell them apart.
- **An attachment given only by `url` is fetched over HTTPS**, never from a private or internal address, with a 30-second timeout and `maxMediaBytes` as its limit.
- **A bare `@number` in outgoing text stays text.** Mention someone with `thread.mentionUser(id)`.
- **`forwardMessage` and event call links fail on current WhatsApp Web.** whatsapp-web.js still calls modules WhatsApp has renamed; both return once it catches up. `sendEvent` without `callType` attaches no link and works.

## License

MIT
