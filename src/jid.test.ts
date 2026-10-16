import { describe, expect, it } from "vitest";
import { extractMentions, isGroupId, isNewsletterId, isUserId, toChatId, toUser } from "./jid";

describe("jid", () => {
  it("classifies chat IDs by their suffix", () => {
    expect(isGroupId("1234567890-1234567890@g.us")).toBe(true);
    expect(isGroupId("15551234567@c.us")).toBe(false);
    expect(isNewsletterId("120363000000000000@newsletter")).toBe(true);
    expect(isUserId("15551234567@c.us")).toBe(true);
    expect(isUserId("1234567890-1234567890@g.us")).toBe(false);
    expect(isUserId("120363000000000000@newsletter")).toBe(false);
  });

  it("normalizes bare numbers and leaves chat IDs alone", () => {
    expect(toChatId("15551234567")).toBe("15551234567@c.us");
    expect(toChatId("+1 (555) 123-4567")).toBe("15551234567@c.us");
    expect(toChatId("1234567890-1234567890@g.us")).toBe("1234567890-1234567890@g.us");
  });

  it("extracts the user part of a chat ID", () => {
    expect(toUser("15551234567@c.us")).toBe("15551234567");
    expect(toUser("15551234567")).toBe("15551234567");
  });

  describe("extractMentions", () => {
    it("rewrites SDK mention tokens into WhatsApp form", () => {
      const result = extractMentions("hey <@15551234567@c.us>, ready?");
      expect(result.text).toBe("hey @15551234567, ready?");
      expect(result.mentions).toEqual(["15551234567@c.us"]);
    });

    it("accepts bare numbers inside a mention token", () => {
      const result = extractMentions("<@15551234567> ping");
      expect(result.text).toBe("@15551234567 ping");
      expect(result.mentions).toEqual(["15551234567@c.us"]);
    });

    it("picks up plain @number mentions the user typed", () => {
      const result = extractMentions("cc @15559876543");
      expect(result.text).toBe("cc @15559876543");
      expect(result.mentions).toEqual(["15559876543@c.us"]);
    });

    it("deduplicates a user mentioned in both forms", () => {
      const result = extractMentions("<@15551234567@c.us> and again @15551234567");
      expect(result.mentions).toEqual(["15551234567@c.us"]);
    });

    it("leaves ordinary text untouched", () => {
      const result = extractMentions("email me at me@example.com, 50% off");
      expect(result.text).toBe("email me at me@example.com, 50% off");
      expect(result.mentions).toEqual([]);
    });
  });

  it("rewrites mention tokens in linear time, whatever the input", () => {
    const started = Date.now();
    extractMentions("<@".repeat(32_000));
    expect(Date.now() - started).toBeLessThan(50);
  });
});
