import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { createWWebJSAdapter, requireWWebJSAdapter } from "chat-adapter-wwebjs";
import qrcode from "qrcode-terminal";
import { LocalAuth } from "whatsapp-web.js";

const whatsapp = createWWebJSAdapter({
  adapterName: "whatsapp",
  clientOptions: { authStrategy: new LocalAuth({ dataPath: "./.wwebjs-auth" }) },
  markSeen: true,
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
  await thread.post(`Hi ${message.author.userName}, I'm listening in this chat now.`);
});

bot.onSubscribedMessage(async (thread, message) => {
  await thread.startTyping();

  if (message.attachments.length > 0) {
    const [attachment] = message.attachments;
    const bytes = await attachment!.fetchData!();
    await thread.post(`Got your ${attachment!.type} — ${bytes.byteLength} bytes.`);
    return;
  }

  if (message.text === "/lunch") {
    const wa = requireWWebJSAdapter(thread);
    const poll = await wa.sendPoll({
      options: ["Tacos", "Sushi", "Ramen"],
      question: "Lunch?",
      threadId: thread.id,
    });
    wa.onPollVote(poll.id, async (vote) => {
      await thread.post(`${vote.voter.userName} picked ${vote.selectedOptions.join(", ")}`);
    });
    return;
  }

  if (message.text === "/where") {
    await requireWWebJSAdapter(thread).sendLocation({
      address: "San Francisco, CA",
      latitude: 37.7749,
      longitude: -122.4194,
      name: "San Francisco",
      threadId: thread.id,
    });
    return;
  }

  if (message.text === "/history") {
    const { messages } = await thread.adapter.fetchMessages(thread.id, { limit: 5 });
    await thread.post({
      markdown: `**Last ${messages.length}:**\n${messages.map((m) => `- ${m.text}`).join("\n")}`,
    });
    return;
  }

  await thread.post({ markdown: `You said: _${message.text}_` });
});

bot.onReaction(async (event) => {
  if (event.added) await event.thread.post(`Thanks for the ${event.emoji}!`);
});

whatsapp.onCall(async (call) => {
  await call.reject();
});

await bot.initialize();
await whatsapp.connect();

process.on("SIGTERM", () => void whatsapp.disconnect());
