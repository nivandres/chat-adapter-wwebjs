# chat-adapter-wwebjs

## 0.1.0

Initial release, tested against live WhatsApp in DMs and groups through `chat-adapter-remote`.

- Full Chat SDK `Adapter` surface over whatsapp-web.js: posting, editing, deleting, quoted replies, reactions, typing and recording indicators, read receipts, attachments, thread and channel metadata, contact lookup and DM opening.
- Real message history with forward and backward pagination over `chat.fetchMessages`.
- Inbound bridging for messages, edits, deletes, reactions and group joins. The bot's own edits, deletes and reactions stay out unless `receiveOwnMessages` is on, and so do contacts' statuses, broadcast lists and WhatsApp's own notifications.
- Mentions by number or LID reach `onNewMention`, the bot's LID learned once the session is ready, and a reply to one of the bot's messages counts as one. A mention reads as `@` and the name in `message.text`.
- A dropped session is opened again with backoff, including one whose browser crashed, which WhatsApp never reports; see `reconnect`. A logout is never retried.
- `maxMediaBytes` bounds the media read into memory at 64 MB, counting the bytes as they stream rather than trusting the size the sender declared. Attachments given by `url` are fetched with a timeout, refused on an error status, and held to the same limit.
- Inbound text from anyone is safe to handle: a failing handler is logged rather than ending the process, mention names stay literal, contact lookups per message are capped, and markdown too long or too deep for the parser stays plain.
- WhatsApp extras: polls with decrypted votes, locations, scheduled events, stickers, forwarding, pinning, starring, message search, group participants, presence, and chat state.
- `sendEvent` attaches no call link unless `callType` asks for one.
- One DM thread per person: `openDM` resolves a number and its `@c.us` id alike, to the chat WhatsApp uses — often a LID.
- Deleted messages keep their own id, and history cursors stay put when messages arrive between pages.
- A bare URL or address is printed once, not followed by itself in parentheses.
- A contact or quoted message WhatsApp never returns holds a message back at most 5 seconds.
- `adapter.client` exposes the underlying whatsapp-web.js client.
