import { ValidationError } from "@chat-adapter/shared";
import type {
  DateInputElement,
  ExternalSelectElement,
  ModalElement,
  NumberInputElement,
  OptionsLoadResult,
  RadioSelectElement,
  SelectElement,
  SelectOptionElement,
  TextInputElement,
} from "chat";
import { cardToText } from "./format-converter.js";
import type { WWebJSModalTexts } from "./types.js";

export type Field =
  | DateInputElement
  | ExternalSelectElement
  | NumberInputElement
  | RadioSelectElement
  | SelectElement
  | TextInputElement;

/** A modal under way in one thread with one person: what is left to ask, and what they answered. */
export interface Form {
  callbackId: string;
  closeLabel?: string;
  contextId?: string;
  fields: Field[];
  /** Options a search for the current field found, waiting for a pick. */
  found?: SelectOptionElement[];
  notifyOnClose?: boolean;
  pending: string[];
  privateMetadata?: string;
  values: Record<string, string>;
  viewId: string;
}

/** What an answer did: settled the field, or needs telling the person why not, or a search first. */
export type Answer = { error: string } | { search: string } | { value?: string };

export const DEFAULT_MODAL_TEXTS: WWebJSModalTexts = {
  cancel: "cancel",
  cancelHint: "Send *cancel* to stop.",
  cancelled: "Cancelled.",
  invalid: "That doesn't fit. Try again:",
  noResults: "Nothing matched. Try other words:",
  search: "Send a few words to search.",
  skip: "skip",
  skipHint: "Send *skip* to leave it as it is.",
};

const INPUTS = new Set<string>([
  "date_input",
  "external_select",
  "number_input",
  "radio_select",
  "select",
  "text_input",
]);

/** Opaque to the SDK; carries where a modal opens and for whom, since WhatsApp has no trigger of its own. */
export function triggerIdOf(threadId: string, userId: string): string {
  return JSON.stringify([threadId, userId]);
}

export function fromTrigger(triggerId: string): [threadId: string, userId: string] {
  let ids: unknown;
  try {
    ids = JSON.parse(triggerId);
  } catch {
    ids = undefined;
  }
  const [threadId, userId] = Array.isArray(ids) ? ids : [];
  if (typeof threadId === "string" && typeof userId === "string") return [threadId, userId];
  throw new ValidationError("wwebjs", `Not a trigger this adapter issued: ${triggerId}`);
}

export function createForm(modal: ModalElement, viewId: string, contextId?: string): Form {
  const fields = modal.children.filter((child): child is Field => INPUTS.has(child.type));
  return {
    callbackId: modal.callbackId,
    closeLabel: modal.closeLabel,
    contextId,
    fields,
    notifyOnClose: modal.notifyOnClose,
    pending: fields.map(({ id }) => id),
    privateMetadata: modal.privateMetadata,
    values: {},
    viewId,
  };
}

/** The title, any text or fields the modal shows, and how to stop. */
export function introOf(modal: ModalElement, texts: WWebJSModalTexts): string {
  const shown = modal.children.filter((child) => child.type === "text" || child.type === "fields");
  return [
    cardToText({ children: shown, title: modal.title, type: "card" }),
    `_${texts.cancelHint}_`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function currentField(form: Form): Field | undefined {
  return form.fields.find(({ id }) => id === form.pending[0]);
}

function optionsOf(field: Field, form: Form): SelectOptionElement[] | undefined {
  if (field.type === "select" || field.type === "radio_select") return field.options;
  return field.type === "external_select" ? form.found : undefined;
}

function initialOf(field: Field): string | undefined {
  switch (field.type) {
    case "select":
    case "radio_select":
      return field.initialOption;
    case "external_select":
      return field.initialOption?.value;
    case "number_input":
      return field.initialValue === undefined ? undefined : String(field.initialValue);
    default:
      return field.initialValue;
  }
}

export function questionOf(field: Field, form: Form, texts: WWebJSModalTexts): string {
  const options = optionsOf(field, form);
  const initial = initialOf(field);
  const shown =
    field.type === "external_select"
      ? field.initialOption?.label
      : (options?.find(({ value }) => value === initial)?.label ?? initial);
  const range =
    field.type === "number_input" && [field.min, field.max].some((n) => n !== undefined);
  return [
    `*${field.label}*`,
    "placeholder" in field && field.placeholder && `_${field.placeholder}_`,
    options
      ?.map((option, index) =>
        [`${index + 1}. ${option.label}`, option.description].filter(Boolean).join(": "),
      )
      .join("\n"),
    field.type === "date_input" && "_YYYY-MM-DD_",
    range && `_${field.min ?? "…"} – ${field.max ?? "…"}_`,
    field.type === "external_select" && !options && `_${texts.search}_`,
    (field.optional || initial !== undefined) &&
      `_${texts.skipHint}_${shown === undefined ? "" : ` (${shown})`}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function pick(options: SelectOptionElement[], text: string): SelectOptionElement | undefined {
  return /^\d+$/.test(text)
    ? options[Number(text) - 1]
    : options.find(({ label }) => label.toLowerCase() === text.toLowerCase());
}

/** Reads one reply against the field it answers; never throws, since the text is anyone's. */
export function answerOf(field: Field, form: Form, text: string, texts: WWebJSModalTexts): Answer {
  const invalid = { error: texts.invalid };
  if (text.toLowerCase() === texts.skip.toLowerCase()) {
    const initial = initialOf(field);
    return field.optional || initial !== undefined ? { value: initial } : invalid;
  }
  switch (field.type) {
    case "text_input":
      return text && text.length <= (field.maxLength ?? Infinity) ? { value: text } : invalid;
    case "number_input": {
      const number = Number(text.replace(",", "."));
      const fits =
        text !== "" &&
        Number.isFinite(number) &&
        (field.decimal || Number.isInteger(number)) &&
        number >= (field.min ?? -Infinity) &&
        number <= (field.max ?? Infinity);
      return fits ? { value: String(number) } : invalid;
    }
    case "date_input": {
      const date = new Date(`${text}T00:00:00Z`);
      const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(text) &&
        !Number.isNaN(date.getTime()) &&
        date.toISOString().startsWith(text);
      return valid ? { value: text } : invalid;
    }
    case "external_select": {
      const chosen = form.found && pick(form.found, text);
      if (chosen) return { value: chosen.value };
      return text.length >= (field.minQueryLength ?? 1) ? { search: text } : invalid;
    }
    default: {
      const chosen = pick(field.options, text);
      return chosen ? { value: chosen.value } : invalid;
    }
  }
}

export function flattenOptions(result: OptionsLoadResult | undefined): SelectOptionElement[] {
  return (result ?? []).flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}
