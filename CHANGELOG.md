# chat-adapter-wwebjs

## 0.3.0

### Changed

- Needs `chat` and `@chat-adapter/shared` 4.44 or newer, for Chat SDK's bounded parsing below.

### Fixed

- An incoming message that is slow to parse as markdown, such as thousands of `*` or quotes nested hundreds deep, could hold the session for seconds or overflow the stack. Messages are now parsed with Chat SDK's `parseIncoming()`, as its own WhatsApp adapter does, so text over its limits keeps its content in `formatted` as plain text. `text` is unchanged.

## 0.2.1

### Fixed

- No session could link since WhatsApp Web removed the module whatsapp-web.js waited on, around 2026-11-25: `connect()` failed after 30 seconds with `auth timeout`, with every release up to 1.34.8 and with the commit this adapter pointed to. It is now tested against whatsapp-web.js `38eb45b`, which reads the new one, and the README installs that commit by its full SHA, since npm resolves a short one over SSH and fails without a GitHub SSH key.
- `connect()` now says what to do when whatsapp-web.js times out this way: the error names the installed version and the commit to install.
- A second signal while the browser was closing, as Ctrl+C under `npx` or `npm exec` sends, ended the process before the browser closed, leaving Chromium running with the profile locked. Signals are now listened for until every session has closed.
- The README says how to let npm 11 and bun download Chromium, which they skip until allowed, and how to use a browser you already have.

## 0.2.0

### Changed

- With `receiveOwnMessages`, what the account's owner does on the phone or another linked device reaches your handlers as a person's: `isMe` and `isBot` are `false` and the author is `botUserId`, so `message.author.userId === adapter.botUserId` tells them apart. Everything the account sent used to count as the bot's own, so the Chat SDK skipped its messages, edits, reactions and commands, and only its deletes came through. What the adapter itself sends stays its own, even when WhatsApp echoes a send before it returns: its messages, an edit of one, a reaction it made and a forward. Its messages are recorded in the Chat SDK state for as long as `catchUpMs` reaches back, so catching up after a restart never hands the bot its own; from a position recorded before 0.2.0 or with the option off, which kept no such record, it skips the account's messages altogether. History still counts everything the account sent as the bot's.
- With `receiveOwnMessages`, the owner answers a modal opened for them and runs slash commands like anyone, and quoting the account's own message is no longer a mention. The adapter's own echoes never answer a modal or run a command; one could have answered a modal with its own question.
- `numberedActions()` skips whatever the paired account sends, so its owner never picks a contact's option.

### Fixed

- `manageClient: true` on a client you already started called `initialize()` again, launching a second browser on the same profile that never became ready. Its session is now adopted, as a bridged one is, and the adapter runs it from then on.
- A signal's 8 seconds could end the process while the browser was still closing, leaving Chromium running with the profile locked. A browser still closing then is now ended outright first.
- A process killed outright, by `kill -9`, the OOM killer or a process manager, left its browser running with the profile locked, and every start failed with "The browser is already running" until someone ended it. The next start now ends it and opens the session, but only a browser on the same host and profile whose launching process is gone, never one another process runs.
- A catch-up that could not read its position from the Chat SDK state, or list the chats, never ran again until the session reconnected, and a position that could not be written waited for the next message. The watchdog now tries both again, and `disconnect()` writes a failed position once more. Two catch-ups no longer run at once after quick reconnects.
- An attempt to open the session that a newer one replaced could finish late and take over the newer one's watch on its browser, so closing that browser on purpose read as a crash and opened the session again. A replaced attempt now leaves the session alone, and a bridged client connected again no longer stacks a second watch.

## 0.1.5

### Fixed

- The README and the example imported `LocalAuth` by name, which throws under Node: whatsapp-web.js is CommonJS, so ESM sees only its default export. They now import it as `wwebjs` and take `LocalAuth` from it.
- The README's install failed on pnpm 10, which refuses to build whatsapp-web.js from GitHub and skips Puppeteer's Chromium download until both are allowed in `onlyBuiltDependencies`. It now installs the tested commit in one command and says how to allow both.
- The README now warns that the `LocalAuth` directory signs in as your WhatsApp account and belongs out of version control.

## 0.1.4

### Changed

- A card answered by number with `numberedActions()` follows `richContent` like any other card: plain lines unless it is on. It used WhatsApp's markup either way. Addons read the setting from their context's `richContent`.

### Fixed

- A group message that names the bot as `@` and its `userName`, without a WhatsApp mention, went unnoticed under Chat SDK 4.44, which takes an adapter's `false` as final. The adapter now flags only the mentions WhatsApp marks and leaves the rest for the SDK to detect.
- A card's link buttons were dropped unless `numberedActions()` listed them. They now go out as `Label: url` lines in every card.
- A modal with a `closeLabel` stopped only on that word, although its hint tells people to send _cancel_. Either now stops it.

## 0.1.3

### Added

- A `client` you already started is bridged as it is: its session is adopted without a second `initialize()`, which used to open a second browser on the same profile and never become ready. Its lifecycle stays yours — the adapter no longer reconnects or destroys it, nor closes it on a signal, and `disconnect()` only detaches the adapter's listeners. A client never started is the adapter's to run, as before, and `manageClient` forces either way.
- `streaming` picks how a streamed reply goes out: `"buffer"`, the default, sends it once, whole; `"edit"` edits one message as it grows, at most once a second. The SDK's fallback edited twice a second, which floods a WhatsApp chat.
- Modals, as conversations with `richContent`: `openModal()` asks each field in turn — text, numbers, dates, numbered selects, and searches through `onOptionsLoad` — and hands the answers to `onModalSubmit`, asking again for any field the handler rejects. `modalTexts` puts its phrases in your users' language, and `triggerIdOf()` opens one for anyone.
- `slashCommands` turns messages naming the commands you declare into `onSlashCommand` events, with a trigger to open a modal from.
- `listChats()` lists every chat for an inbox, newest first, and `listThreads()` returns a chat's own thread.
- `richContent` imitates what WhatsApp lacks, and is off by default: a card's images go out as media with the card as caption, the card in WhatsApp's markup — a bold title, `*Label:* value` fields and monospaced tables — and modals as conversations. Off, a card is plain lines and the adapter has no `openModal`, so the SDK knows a modal cannot open. Numbered answers carry a trigger, so an action can open a modal.
- `voiceNotes` also takes `"ogg"`, to send only OGG/Opus audio, which every phone plays, as a voice note. All audio still goes as one by default.
- A `client` from another installed copy of whatsapp-web.js than the adapter's is warned about at once: whatsapp-web.js tells media, locations and polls apart with `instanceof`, so every one it sent would otherwise fail with an opaque error inside the page.
- A location arrives as the place, its address and a map link. Its body used to be the map thumbnail, base64-encoded.

### Changed

- A bare `@number` in outgoing text no longer mentions that person, so echoing what someone wrote cannot ping others. `thread.mentionUser(id)` still does.

### Fixed

- A session whose browser dropped could not be reopened: whatsapp-web.js closes the browser only while it still sees it connected, and hands it over only once its page is set up, so a browser that dropped, or one whose attempt failed or timed out before then, stayed running with the profile locked, and every attempt failed with "The browser is already running" until someone ended it by hand. The adapter now launches each browser with a Puppeteer abort signal and ends the one it started, handed over or not — when reopening, when an attempt fails or times out, and on `disconnect()` — waiting for one handed over to exit before opening the next.
- Reopening a session could start a storm of reconnects: the adapter read its own closing of the old browser as a crash, and each new attempt tore down the one before. One unresponsive session could start dozens of browsers. The adapter's own closing is no longer a crash, and a superseded attempt leaves the newer one alone.
- An authentication failure after a start that failed could end the process with an unhandled rejection, and so could a QR or pairing-code handler that threw.
- Catching up could lose messages: one failing chat or handler stopped it, and live messages moved the position past chats it had not reached. Every chat's missed messages are now gathered and delivered oldest first, each on its own, and the position moves only once the catch-up ends. A truncated catch-up is logged.
- A message delivered live and caught up again reached addons twice, so a numbered answer could run its action twice.
- A numbered answer could run its action again when repeated, and answered the latest card even when it quoted another message or came from the bot's own account. The first pick now ends a card's options.
- A position recorded for one number was reused after pairing another under the same `adapterName`, replaying up to a day of chats. It now belongs to the account that recorded it.
- An attachment given by `url` was fetched from any address, internal ones included. It is now fetched over HTTPS only, never from a private or internal address, with redirects checked.
- Inbound media whose real size is over `maxMediaBytes` is refused before it is streamed, whatever size the sender declared.
- Editing, deleting, reacting to or fetching a message checked only its ID, so a group's message could be touched through another thread. A group's messages must now belong to the thread.
- A signal now gives sessions 8 seconds to close before it ends the process, inside the grace period Docker and Kubernetes allow.

## 0.1.2

### Added

- Messages that arrived while the session was down are delivered once it is back, in order and each once, up to `catchUpMs` old. WhatsApp Web loads them without firing an event, so they were lost.
- Audio goes out as a voice note, played inline with a waveform; `voiceNotes: false` sends it as a file.
- `numberedActions()` lists a card's buttons and select options by number, and a reply with one reaches `onAction`. WhatsApp Web cannot send buttons, so they used to vanish. It is the first of `addons`, layers with hooks for how cards are sent and messages received.
- Chromium starts with `RECOMMENDED_CHROMIUM_ARGS` — one renderer process, no GPU, no component updates — before any `puppeteer.args` of your own; `recommendedArgs: false` leaves them out.

### Fixed

- A SIGTERM never ended the process: Puppeteer closed the browser and kept the process alive, and the adapter read the closed browser as a crash and opened a new one. Every session now closes on SIGINT, SIGTERM and SIGHUP, and the signal then ends the process unless the app handles it; `handleSignals: false` leaves signals alone.

## 0.1.1

### Fixed

- `connectTimeoutMs` also counted the wait for a QR scan, so a first pairing gave up after 2 minutes and the QR on screen stopped working. Once a QR or pairing code is shown, the connection waits on the person scanning it.

## 0.1.0

Initial release, tested against live WhatsApp in DMs and groups through `chat-adapter-remote`.

- Full Chat SDK `Adapter` surface over whatsapp-web.js: posting, editing, deleting, quoted replies, reactions, typing and recording indicators, read receipts, attachments, thread and channel metadata, contact lookup and DM opening.
- Real message history with forward and backward pagination over `chat.fetchMessages`.
- Inbound bridging for messages, edits, deletes, reactions and group joins. The bot's own edits, deletes and reactions stay out unless `receiveOwnMessages` is on, and so do contacts' statuses, broadcast lists and WhatsApp's own notifications.
- Mentions by number or LID reach `onNewMention`, the bot's LID learned once the session is ready, and a reply to one of the bot's messages counts as one. A mention reads as `@` and the name in `message.text`.
- A dropped session is opened again with backoff, including one whose browser crashed, which WhatsApp never reports; see `reconnect`. A logout is never retried. A connection that never becomes ready is abandoned after `connectTimeoutMs`, and a watchdog reopens a session WhatsApp stopped answering without any event.
- `adapter.connection` reports where the session stands, for health checks.
- `maxMediaBytes` bounds the media read into memory at 64 MB, counting the bytes as they stream rather than trusting the size the sender declared. Attachments given by `url` are fetched with a timeout, refused on an error status, and held to the same limit.
- Inbound text from anyone is safe to handle: a failing handler is logged rather than ending the process, mention names stay literal, contact lookups per message are capped, and markdown too long or too deep for the parser stays plain.
- WhatsApp extras: polls with decrypted votes, locations, scheduled events, stickers, forwarding, pinning, starring, message search, group participants, presence, and chat state.
- `sendEvent` attaches no call link unless `callType` asks for one.
- One DM thread per person: `openDM` resolves a number and its `@c.us` id alike, to the chat WhatsApp uses — often a LID.
- Deleted messages keep their own id, and history cursors stay put when messages arrive between pages.
- A bare URL or address is printed once, not followed by itself in parentheses.
- A message can be edited right after it is sent: WhatsApp refuses for a few hundred milliseconds, so a fresh message of the bot's own is retried briefly.
- A contact or quoted message WhatsApp never returns holds a message back at most 5 seconds.
- `adapter.client` exposes the underlying whatsapp-web.js client.
