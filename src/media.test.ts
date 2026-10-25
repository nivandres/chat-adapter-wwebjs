import { downloadAttachment } from "@chat-adapter/shared";
import type { Attachment } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { download, isCaptionable, isVoiceNote, toAttachments, toMedia, toMediaList } from "./media";
import { MessageMedia } from "./wwebjs";

vi.mock("@chat-adapter/shared", async (original) => {
  const shared = await original<typeof import("@chat-adapter/shared")>();
  return { ...shared, downloadAttachment: vi.fn(shared.downloadAttachment) };
});

function waMessage(overrides: Record<string, unknown> = {}) {
  return {
    hasMedia: false,
    id: { _serialized: "false_15551234567@c.us_AAA" },
    rawData: {},
    type: "chat",
    ...overrides,
  } as never;
}

const base64 = (value: string) => Buffer.from(value).toString("base64");

describe("toAttachments", () => {
  it("returns nothing for a message without media", () => {
    expect(toAttachments(waMessage({ type: "chat" }))).toEqual([]);
  });

  it.each([
    ["image", "image"],
    ["sticker", "image"],
    ["video", "video"],
    ["audio", "audio"],
    ["ptt", "audio"],
    ["document", "file"],
    ["something-new", "file"],
  ])("maps a %s message to a %s attachment", (type, expected) => {
    const [attachment] = toAttachments(waMessage({ hasMedia: true, type }));
    expect(attachment?.type).toBe(expected);
  });

  it("carries the media metadata WhatsApp reported", () => {
    const [attachment] = toAttachments(
      waMessage({
        hasMedia: true,
        rawData: {
          filename: "report.pdf",
          height: 200,
          mimetype: "application/pdf",
          size: 42,
          width: 100,
        },
        type: "document",
      }),
    );
    expect(attachment).toMatchObject({
      height: 200,
      mimeType: "application/pdf",
      name: "report.pdf",
      size: 42,
      type: "file",
      width: 100,
    });
  });

  it("stores the message ID so the download can be rebuilt later", () => {
    const [attachment] = toAttachments(waMessage({ hasMedia: true, type: "image" }));
    expect(attachment?.fetchMetadata).toEqual({ messageId: "false_15551234567@c.us_AAA" });
  });
});

describe("download", () => {
  it("decodes the base64 payload WhatsApp returns", async () => {
    const message = waMessage({
      downloadMedia: async () => ({ data: base64("hello") }),
      hasMedia: true,
    });
    expect((await download(message)).toString()).toBe("hello");
  });

  it("explains when the media has expired", async () => {
    const message = waMessage({ downloadMedia: async () => undefined, hasMedia: true });
    await expect(download(message)).rejects.toThrow("no longer available");
  });
});

describe("toMedia", () => {
  it("uses the declared MIME type of a file upload", async () => {
    const media = await toMedia({
      data: Buffer.from("x"),
      filename: "a.bin",
      mimeType: "text/csv",
    });
    expect(media).toMatchObject({ data: base64("x"), filename: "a.bin", mimetype: "text/csv" });
  });

  it("infers a MIME type from the file extension", async () => {
    expect((await toMedia({ data: Buffer.from("x"), filename: "a.PNG" })).mimetype).toBe(
      "image/png",
    );
    expect((await toMedia({ data: Buffer.from("x"), filename: "a.ogg" })).mimetype).toBe(
      "audio/ogg",
    );
  });

  it("falls back to a generic MIME type for unknown extensions", async () => {
    expect((await toMedia({ data: Buffer.from("x"), filename: "a.xyz" })).mimetype).toBe(
      "application/octet-stream",
    );
    expect((await toMedia({ data: Buffer.from("x"), filename: "noext" })).mimetype).toBe(
      "application/octet-stream",
    );
  });

  it("accepts ArrayBuffer and Blob payloads", async () => {
    const bytes = new Uint8Array([104, 105]);
    expect((await toMedia({ data: bytes.buffer, filename: "a.txt" })).data).toBe(base64("hi"));
    expect((await toMedia({ data: new Blob(["hi"]), filename: "a.txt" })).data).toBe(base64("hi"));
  });

  it("sends an attachment that already holds its bytes", async () => {
    const attachment: Attachment = {
      data: Buffer.from("bytes"),
      mimeType: "image/png",
      name: "shot.png",
      size: 5,
      type: "image",
    };
    expect(await toMedia(attachment)).toMatchObject({
      data: base64("bytes"),
      filename: "shot.png",
      filesize: 5,
      mimetype: "image/png",
    });
  });

  it("resolves an attachment through fetchData", async () => {
    const attachment: Attachment = {
      fetchData: async () => Buffer.from("lazy"),
      mimeType: "image/png",
      type: "image",
    };
    expect((await toMedia(attachment)).data).toBe(base64("lazy"));
  });

  it("fetches a URL-only attachment within the size limit, typed by the response", async () => {
    vi.mocked(downloadAttachment).mockImplementationOnce(async (_url, options) => {
      options.onResponse?.({ headers: { "content-type": "image/png; q=1" } } as never);
      return Buffer.from("remote");
    });
    const media = await toMedia({ type: "image", url: "https://example.com/a.png" }, 4096);
    expect(media).toMatchObject({
      data: base64("remote"),
      filename: "a.png",
      mimetype: "image/png",
    });
    expect(downloadAttachment).toHaveBeenCalledWith(
      "https://example.com/a.png",
      expect.objectContaining({ adapter: "wwebjs", limit: 4096 }),
    );
  });

  it("never fetches from a private address or over plain HTTP", async () => {
    for (const url of [
      "https://127.0.0.1/a.png",
      "https://169.254.169.254/latest",
      "http://example.com/a.png",
    ]) {
      await expect(toMedia({ type: "image", url })).rejects.toThrow();
    }
  });

  it("never takes a MIME type from the object prototype", async () => {
    const media = await toMedia({ data: Buffer.from("x"), filename: "a.__proto__" });
    expect(media.mimetype).toBe("application/octet-stream");
  });

  it("refuses an attachment with nothing to send", async () => {
    await expect(toMedia({ type: "image" })).rejects.toThrow("no data, fetchData, or url");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe("download", () => {
  const stream = (size: number) => ({
    stream: (async function* () {
      for (let sent = 0; sent < size; sent += 4) yield Buffer.alloc(Math.min(4, size - sent));
    })(),
  });

  it("counts the bytes it streams, whatever size the sender declared", async () => {
    const message = waMessage({
      downloadMediaStream: vi.fn(async () => stream(10)),
      hasMedia: true,
      rawData: { size: 1 },
    });
    await expect(download(message, 8)).rejects.toThrow("over the 8-byte limit");
  });

  it("refuses a blob WhatsApp reports as too large before streaming it", async () => {
    const message = waMessage({
      downloadMediaStream: vi.fn(async () => ({ ...stream(4), blobSize: 9 })),
      hasMedia: true,
    });
    await expect(download(message, 8)).rejects.toThrow("9 bytes or more, over the 8-byte limit");
  });

  it("returns the streamed bytes when they fit", async () => {
    const message = waMessage({
      downloadMediaStream: vi.fn(async () => stream(6)),
      hasMedia: true,
    });
    expect((await download(message, 8)).length).toBe(6);
  });

  it("checks the size of media handed over whole, when it cannot stream", async () => {
    const message = waMessage({
      downloadMedia: vi.fn(async () => ({ data: base64("123456789") })),
      hasMedia: true,
    });
    await expect(download(message, 8)).rejects.toThrow("over the 8-byte limit");
  });
});

describe("toMediaList", () => {
  it("converts attachments and files together, attachments first", async () => {
    const media = await toMediaList({
      attachments: [
        { data: Buffer.from("a"), mimeType: "image/png", name: "a.png", type: "image" },
      ],
      files: [{ data: Buffer.from("b"), filename: "b.pdf" }],
      raw: "both",
    });
    expect(media.map((item) => item.filename)).toEqual(["a.png", "b.pdf"]);
  });

  it("returns nothing for a plain string message", async () => {
    expect(await toMediaList("hello")).toEqual([]);
  });
});

describe("isVoiceNote", () => {
  it("is true only for OGG audio, which every phone plays as a voice note", () => {
    expect(isVoiceNote(new MessageMedia("audio/ogg; codecs=opus", ""))).toBe(true);
    expect(isVoiceNote(new MessageMedia("audio/mpeg", ""))).toBe(false);
  });
});

describe("isCaptionable", () => {
  it("is true for everything except audio", () => {
    expect(isCaptionable(new MessageMedia("image/png", ""))).toBe(true);
    expect(isCaptionable(new MessageMedia("video/mp4", ""))).toBe(true);
    expect(isCaptionable(new MessageMedia("application/pdf", ""))).toBe(true);
    expect(isCaptionable(new MessageMedia("audio/ogg", ""))).toBe(false);
  });
});
