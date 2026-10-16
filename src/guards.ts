import { ValidationError } from "@chat-adapter/shared";
import { WWebJSAdapter } from "./adapter.js";

/** Narrow an unknown adapter to {@link WWebJSAdapter}. */
export function isWWebJSAdapter(value: unknown): value is WWebJSAdapter {
  return value instanceof WWebJSAdapter;
}

/**
 * Require that a Chat SDK context belongs to a {@link WWebJSAdapter}.
 *
 * Accepts the adapter itself or anything carrying one, such as a `Thread`,
 * `Channel` or `SentMessage`.
 */
export function requireWWebJSAdapter(value: unknown): WWebJSAdapter {
  const adapter =
    value && typeof value === "object" && "adapter" in value
      ? (value as { adapter: unknown }).adapter
      : value;
  if (isWWebJSAdapter(adapter)) return adapter;
  throw new ValidationError("wwebjs", "This context does not belong to a wwebjs adapter.");
}
