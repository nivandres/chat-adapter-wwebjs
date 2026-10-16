import { extractFiles, extractPostableAttachments, ValidationError } from "@chat-adapter/shared";
import type { AdapterPostableMessage, Attachment, FileUpload } from "chat";
import type { Message as WAMessage, MessageMedia as WAMessageMedia } from "whatsapp-web.js";
import { MessageMedia } from "./wwebjs.js";

const ATTACHMENT_TYPES: Record<string, Attachment["type"]> = {
  audio: "audio",
  document: "file",
  image: "image",
  ptt: "audio",
  sticker: "image",
  video: "video",
};

const MIME_TYPES: Record<string, string> = {
  aac: "audio/aac",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";
const DEFAULT_MAX_MEDIA_BYTES = 64 * 1024 * 1024;

interface RawMediaData {
  filename?: string;
  height?: number;
  mimetype?: string;
  size?: number;
  width?: number;
}

/** Describe an inbound message's media as a Chat SDK attachment. */
export function toAttachments(message: WAMessage, maxBytes?: number): Attachment[] {
  if (!message.hasMedia) return [];
  const data = (message.rawData ?? {}) as RawMediaData;
  return [
    {
      fetchData: () => download(message, maxBytes),
      fetchMetadata: { messageId: message.id._serialized },
      height: data.height,
      mimeType: data.mimetype,
      name: data.filename,
      size: data.size,
      type: ATTACHMENT_TYPES[message.type] ?? "file",
      url: undefined,
      width: data.width,
    },
  ];
}

/** Download an inbound message's media as raw bytes, refusing media larger than `maxBytes`. */
export async function download(
  message: WAMessage,
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
): Promise<Buffer> {
  const size = ((message.rawData ?? {}) as RawMediaData).size;
  if (size && size > maxBytes) {
    throw new ValidationError(
      "wwebjs",
      `Media for message ${message.id._serialized} is ${size} bytes, over the ${maxBytes}-byte limit.`,
    );
  }
  const media = await message.downloadMedia();
  if (!media?.data) {
    throw new ValidationError(
      "wwebjs",
      `Media for message ${message.id._serialized} is no longer available for download.`,
    );
  }
  return Buffer.from(media.data, "base64");
}

/** Convert every attachment and file on a postable message into WhatsApp media. */
export function toMediaList(message: AdapterPostableMessage): Promise<WAMessageMedia[]> {
  return Promise.all(
    [...extractPostableAttachments(message), ...extractFiles(message)].map(toMedia),
  );
}

/** Convert a single attachment or file upload into WhatsApp media. */
export async function toMedia(source: Attachment | FileUpload): Promise<WAMessageMedia> {
  if ("filename" in source) {
    return new MessageMedia(
      source.mimeType ?? mimeTypeOf(source.filename),
      await toBase64(source.data),
      source.filename,
    );
  }
  const data = source.data ?? (await source.fetchData?.());
  if (!data) {
    if (!source.url) {
      throw new ValidationError("wwebjs", "Attachment has no data, fetchData, or url to send.");
    }
    return MessageMedia.fromUrl(source.url, { unsafeMime: true, filename: source.name });
  }
  return new MessageMedia(
    source.mimeType ?? mimeTypeOf(source.name),
    await toBase64(data),
    source.name ?? null,
    source.size ?? null,
  );
}

/** WhatsApp renders a caption on every media kind except audio. */
export function isCaptionable(media: WAMessageMedia): boolean {
  return !media.mimetype.startsWith("audio/");
}

function mimeTypeOf(filename?: string): string {
  const extension = filename?.split(".").pop()?.toLowerCase();
  return (extension && MIME_TYPES[extension]) || DEFAULT_MIME_TYPE;
}

async function toBase64(data: ArrayBuffer | Blob | Buffer): Promise<string> {
  if (Buffer.isBuffer(data)) return data.toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  return Buffer.from(await data.arrayBuffer()).toString("base64");
}
