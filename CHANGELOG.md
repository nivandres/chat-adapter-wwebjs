# chat-adapter-wwebjs

## 0.1.0

Initial release, tested against live WhatsApp in DMs and groups through `chat-adapter-remote`.

- Full Chat SDK `Adapter` surface over whatsapp-web.js: posting, editing, deleting, quoted replies, reactions, typing and recording indicators, read receipts, attachments, thread and channel metadata, contact lookup and DM opening.
- Real message history with forward and backward pagination over `chat.fetchMessages`.
- Inbound bridging for messages, edits, deletes, reactions and group joins. The bot's own edits, deletes and reactions stay out unless `receiveOwnMessages` is on, and so do contacts' statuses, broadcast lists and WhatsApp's own notifications.
- Mentions by number or LID reach `onNewMention`, the bot's LID learned once the session is ready, and a reply to one of the bot's messages counts as one. A mention reads as `@` and the name in `message.text`.
- A dropped session is opened again with backoff; see `reconnect`. A logout is never retried.
- `maxMediaBytes` refuses inbound media over 64 MB before it is read into memory.
- WhatsApp extras: polls with decrypted votes, locations, scheduled events, stickers, forwarding, pinning, starring, message search, group participants, presence, and chat state.
- `adapter.client` exposes the underlying whatsapp-web.js client.
