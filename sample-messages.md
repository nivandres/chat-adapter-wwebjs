# Sample payloads

What the adapter receives from whatsapp-web.js, and what it turns each one into.
These are the shapes the tests in [`src/`](./src) are built against: a
`whatsapp-web.js` `Message` with its raw WhatsApp Web model on `rawData`.

Fields not used by the adapter are trimmed. IDs are fictional.

## Direct message

`client.on("message_create", …)` with `fromMe: false`.

```js
{
  id: {
    fromMe: false,
    remote: "15551234567@c.us",
    id: "3EB0C767D26B8O0A1F1E",
    _serialized: "false_15551234567@c.us_3EB0C767D26B8O0A1F1E",
  },
  body: "hey, is the order ready?",
  type: "chat",
  from: "15551234567@c.us",
  to: "15550000000@c.us",
  fromMe: false,
  hasMedia: false,
  hasQuotedMsg: false,
  timestamp: 1700000000,
  mentionedIds: [],
  links: [],
  rawData: { notifyName: "Alice" },
}
```

Becomes a `Message` with `threadId: "wwebjs:15551234567@c.us"`,
`author.userId: "15551234567@c.us"`, `author.userName: "Alice"`,
`isMention: false`, `metadata.dateSent: 2023-11-14T22:13:20.000Z`.

Because it is a DM, the SDK routes it to `onDirectMessage` / `onNewMention`
without needing an `@` in the body.

## Group mention

WhatsApp mentions are IDs, not names: the body carries `@15550000000` and the
mentioned chat IDs arrive separately in `mentionedIds`.

```js
{
  id: {
    fromMe: false,
    remote: "1234567890-1234567890@g.us",
    id: "3EB0A1B2C3D4E5F60718",
    _serialized: "false_1234567890-1234567890@g.us_3EB0A1B2C3D4E5F60718",
  },
  body: "@15550000000 can you check this?",
  type: "chat",
  from: "1234567890-1234567890@g.us",
  author: "15551234567@c.us",
  to: "15550000000@c.us",
  fromMe: false,
  hasMedia: false,
  timestamp: 1700000100,
  mentionedIds: ["15550000000@c.us"],
  links: [],
  rawData: { notifyName: "Alice" },
}
```

`author` is the sender, `from` is the group. The adapter attributes the message
to `15551234567@c.us` and the thread to `wwebjs:1234567890-1234567890@g.us`, and
sets `isMention: true` from `mentionedIds` — the SDK's own text matching cannot
see this kind of mention, since it looks for `@wwebjs-bot` or
`@15550000000@c.us`.

## Image with a caption

`hasMedia` is derived from `directPath`; for media messages `body` holds the
caption.

```js
{
  id: {
    fromMe: false,
    remote: "15551234567@c.us",
    id: "3EB0111213141516171A",
    _serialized: "false_15551234567@c.us_3EB0111213141516171A",
  },
  body: "here's the receipt",
  type: "image",
  from: "15551234567@c.us",
  fromMe: false,
  hasMedia: true,
  timestamp: 1700000200,
  rawData: {
    notifyName: "Alice",
    caption: "here's the receipt",
    mimetype: "image/jpeg",
    filename: null,
    size: 84213,
    width: 1080,
    height: 1440,
    directPath: "/v/t62.7118-24/12345_678_90.enc",
  },
}
```

Becomes one attachment:

```js
{
  type: "image",
  mimeType: "image/jpeg",
  size: 84213,
  width: 1080,
  height: 1440,
  fetchData: () => Promise<Buffer>,
  fetchMetadata: { messageId: "false_15551234567@c.us_3EB0111213141516171A" },
}
```

Nothing is downloaded until `fetchData()` is called; it decodes the base64 from
`message.downloadMedia()`. `fetchMetadata` lets `rehydrateAttachment` rebuild
that closure after a message has been serialized through a queue.

Voice notes arrive as `type: "ptt"` and documents as `type: "document"` with
`rawData.filename` set; both map the same way.

## Reaction

`client.on("message_reaction", …)` — a `Reaction`, not a `Message`. `id` is the
reaction itself, `msgId` is what was reacted to.

```js
{
  id: {
    fromMe: false,
    remote: "15551234567@c.us",
    id: "3EB0999888777666555",
    _serialized: "false_15551234567@c.us_3EB0999888777666555",
  },
  msgId: { _serialized: "true_15551234567@c.us_3EB0AAA111BBB222CCC" },
  reaction: "👍",
  senderId: "15551234567@c.us",
  timestamp: 1700000300,
}
```

Dispatched to `chat.processReaction` with `added: true`,
`emoji.name: "thumbs_up"` and `rawEmoji: "👍"`. An empty `reaction` string means
the reaction was removed, so `added: false`.

## Poll vote

`client.on("vote_update", …)`. whatsapp-web.js decrypts the vote, so the option
names arrive directly and the poll it belongs to comes along as
`parentMessage`.

```js
{
  voter: "15551234567@c.us",
  selectedOptions: [{ id: 0, name: "Tacos" }],
  interractedAtTs: 1700000400,
  parentMessage: {
    id: { fromMe: true, remote: "1234567890-1234567890@g.us", _serialized: "true_1234567890-1234567890@g.us_POLL1" },
    type: "poll_creation",
    pollName: "Lunch?",
    pollOptions: ["Tacos", "Sushi", "Ramen"],
    allowMultipleAnswers: false,
    fromMe: true,
    timestamp: 1700000350,
  },
}
```

Delivered to `onPollVote` handlers as `{ question: "Lunch?", options: [...],
selectedOptions: ["Tacos"], voter, pollMessageId, threadId }`. An empty
`selectedOptions` means the voter cleared their vote.

## Edit

`client.on("message_edit", message, newBody, prevBody)`.

```js
// message
{
  id: { fromMe: false, remote: "15551234567@c.us", _serialized: "false_15551234567@c.us_3EB0EDIT" },
  body: "make that two boxes",
  latestEditSenderTimestampMs: 1700000500000,
  timestamp: 1700000450,
}
// newBody: "make that two boxes"
// prevBody: "make that one box"
```

Dispatched to `chat.processMessageUpdated` with `message` carrying the new body
and `previousMessage` carrying `prevBody`.

## Delete for everyone

`client.on("message_revoke_everyone", message, revoked)`. The first argument is
the tombstone; the second is the original, and may be `undefined` when
whatsapp-web.js did not capture it in time.

```js
// message (tombstone)
{
  id: { fromMe: false, remote: "15551234567@c.us", _serialized: "false_15551234567@c.us_3EB0TOMB" },
  type: "revoked",
  body: "",
  timestamp: 1700000600,
}
// revoked (original, may be undefined)
{
  id: { fromMe: false, remote: "15551234567@c.us", _serialized: "false_15551234567@c.us_3EB0ORIG" },
  body: "ignore that",
  timestamp: 1700000550,
}
```

Dispatched to `chat.processMessageDeleted` with the original's ID when it is
available, falling back to `protocolMessageKey` and then the tombstone's own ID.

## Group join

`client.on("group_join", …)` — a `GroupNotification`.

```js
{
  type: "add",
  chatId: "1234567890-1234567890@g.us",
  author: "15551234567@c.us",
  recipientIds: ["15559999999@c.us"],
  body: "",
  timestamp: 1700000700,
}
```

Reported to `onGroupEvent` as `{ type: "join", threadId, authorId, userIds }`
and bridged to the SDK's `processMemberJoinedChannel`, one call per recipient.
`group_leave`, `group_update`, `group_admin_changed` and
`group_membership_request` reach `onGroupEvent` only.
