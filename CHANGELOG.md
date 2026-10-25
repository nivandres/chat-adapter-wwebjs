# chat-adapter-wwebjs

## 0.1.3

### Added

- A `client` you already started is bridged as it is: its session is adopted without a second `initialize()`, which used to open a second browser on the same profile and never become ready. Its lifecycle stays yours — the adapter no longer reconnects or destroys it, nor closes it on a signal, and `disconnect()` only detaches the adapter's listeners. A client never started is the adapter's to run, as before, and `manageClient` forces either way.
- `streaming` picks how a streamed reply goes out: `"buffer"`, the default, sends it once, whole; `"edit"` edits one message as it grows, at most once a second. The SDK's fallback edited twice a second, which floods a WhatsApp chat.
- Modals, as conversations: `openModal()` asks each field in turn — text, numbers, dates, numbered selects, and searches through `onOptionsLoad` — and hands the answers to `onModalSubmit`, asking again for any field the handler rejects. `modalTexts` puts its phrases in your users' language, and `triggerIdOf()` opens one for anyone.
- `slashCommands` turns messages naming the commands you declare into `onSlashCommand` events, with a trigger to open a modal from.
- `listChats()` lists every chat for an inbox, newest first, and `listThreads()` returns a chat's own thread.
- A card's images go out as media with the card as their caption, and the card itself in WhatsApp's markup: a bold title, `*Label:* value` fields and monospaced tables. Numbered answers carry a trigger, so an action can open a modal.
- `voiceNotes` also takes `"ogg"`, to send only OGG/Opus audio, which every phone plays, as a voice note. All audio still goes as one by default.
- A `client` from another installed copy of whatsapp-web.js than the adapter's is warned about at once: whatsapp-web.js tells media, locations and polls apart with `instanceof`, so every one it sent would otherwise fail with an opaque error inside the page.
- A location arrives as the place, its address and a map link. Its body used to be the map thumbnail, base64-encoded.

### Changed

- A bare `@number` in outgoing text no longer mentions that person, so echoing what someone wrote cannot ping others. `thread.mentionUser(id)` still does.

### Fixed

- A session whose browser dropped could not be reopened: whatsapp-web.js closes the browser only while it still sees it connected, so the one that dropped stayed running with the profile locked, and every attempt failed with "The browser is already running" until someone ended it by hand. The adapter now ends the browser it started — when reopening, when an attempt fails, and on `disconnect()` — and waits for it to exit before opening the next.
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
