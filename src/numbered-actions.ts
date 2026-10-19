import { cardToFallbackText } from "@chat-adapter/shared";
import type { ActionsElement, CardChild, CardElement } from "chat";
import type { WWebJSAddon, WWebJSAddonContext } from "./types.js";

export interface NumberedActionsOptions {
  /** Also deliver the reply that picked an option as a message. Defaults to `false`. */
  keepMessage?: boolean;
  /** How long a card's options answer to their number or label. Defaults to 1 day. */
  ttlMs?: number;
}

interface Choice {
  actionId: string;
  label: string;
  value?: string;
}

/** The options of the latest card in a thread, and the message that carried them. */
interface Offer {
  choices: Choice[];
  messageId: string;
}

const TTL_MS = 86_400_000;

function actionsOf(children: CardChild[]): ActionsElement[] {
  return children.flatMap((child) =>
    child.type === "actions" ? [child] : child.type === "section" ? actionsOf(child.children) : [],
  );
}

/** Buttons and select options as numbered lines; a link button keeps its URL, and a modal cannot open on WhatsApp. */
function layout(card: CardElement): { choices: Choice[]; lines: string[] } {
  const choices: Choice[] = [];
  const lines: string[] = [];
  const offer = (choice: Choice) => {
    choices.push(choice);
    lines.push(`${choices.length}. ${choice.label}`);
  };
  for (const { children } of actionsOf(card.children)) {
    for (const action of children) {
      if (action.type === "link-button") lines.push(`${action.label}: ${action.url}`);
      else if (action.type === "button") {
        if (!action.disabled && action.actionType !== "modal") {
          offer({ actionId: action.id, label: action.label, value: action.value });
        }
      } else {
        lines.push(`*${action.label}*`);
        for (const option of action.options) {
          offer({ actionId: action.id, label: option.label, value: option.value });
        }
      }
    }
  }
  return { choices, lines };
}

function keyOf({ adapter, threadId }: WWebJSAddonContext): string {
  return `wwebjs:${adapter.name}:offer:${threadId}`;
}

/**
 * WhatsApp Web cannot send buttons, so a card's buttons and select options are
 * listed by number, and a reply with one — or its label — reaches `onAction`.
 */
export function numberedActions(options: NumberedActionsOptions = {}): WWebJSAddon {
  return {
    renderCard(card) {
      const { lines } = layout(card);
      if (lines.length === 0) return undefined;
      return [cardToFallbackText(card, { boldFormat: "*" }), lines.join("\n")]
        .filter(Boolean)
        .join("\n\n");
    },
    async cardSent(card, messageId, context) {
      const { choices } = layout(card);
      if (choices.length === 0 || !context.chat) return;
      await context.chat
        .getState()
        .set<Offer>(keyOf(context), { choices, messageId }, options.ttlMs ?? TTL_MS);
    },
    async onMessage(message, context) {
      const offer = await context.chat?.getState().get<Offer>(keyOf(context));
      if (!offer || !context.chat) return false;
      const reply = message.text.trim();
      const choice = /^\d+$/.test(reply)
        ? offer.choices[Number(reply) - 1]
        : offer.choices.find(({ label }) => label.toLowerCase() === reply.toLowerCase());
      if (!choice) return false;
      await context.chat.processAction(
        {
          actionId: choice.actionId,
          adapter: context.adapter,
          messageId: offer.messageId,
          raw: message.raw,
          threadId: context.threadId,
          user: message.author,
          value: choice.value,
        },
        undefined,
      );
      return !options.keepMessage;
    },
  };
}
