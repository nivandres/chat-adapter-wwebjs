import { extractFiles, extractPostableAttachments, ValidationError } from "@chat-adapter/shared";
import type { AdapterPostableMessage, Attachment, FileUpload } from "chat";
import type { Readable } from "node:stream";
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
const URL_TIMEOUT_MS = 30_000;

/** whatsapp-web.js main streams media in chunks; 1.34.7 only hands it over whole. */
type StreamableMessage = WAMessage & {
  downloadMediaStream?: () => Promise<{ stream: Readable } | undefined>;
};

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
  if (size && size > maxBytes) throw tooLarge(message.id._serialized, size, maxBytes);
  // The declared size is the sender's to set, so the bytes themselves are counted too.
  const { downloadMediaStream } = message as StreamableMessage;
  if (downloadMediaStream) {
    const streamed = await downloadMediaStream.call(message);
    if (!streamed) throw unavailable(message.id._serialized);
    return collect(streamed.stream, maxBytes, message.id._serialized);
  }
  const media = await message.downloadMedia();
  if (!media?.data) throw unavailable(message.id._serialized);
  const data = Buffer.from(media.data, "base64");
  if (data.length > maxBytes) throw tooLarge(message.id._serialized, data.length, maxBytes);
  return data;
}

/** Convert every attachment and file on a postable message into WhatsApp media. */
export function toMediaList(
  message: AdapterPostableMessage,
  maxBytes?: number,
): Promise<WAMessageMedia[]> {
  return Promise.all(
    [...extractPostableAttachments(message), ...extractFiles(message)].map((source) =>
      toMedia(source, maxBytes),
    ),
  );
}

/**
 * Convert a single attachment or file upload into WhatsApp media. An attachment
 * given only by `url` is fetched from the host's own network, so never pass one
 * an end user chose.
 */
export async function toMedia(
  source: Attachment | FileUpload,
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
): Promise<WAMessageMedia> {
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
    return fetchMedia(source.url, source, maxBytes);
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
  return !isAudio(media);
}

export function isAudio(media: WAMessageMedia): boolean {
  return media.mimetype.startsWith("audio/");
}

function mimeTypeOf(filename?: string): string {
  const extension = filename?.split(".").pop()?.toLowerCase();
  return (
    (extension && Object.hasOwn(MIME_TYPES, extension) && MIME_TYPES[extension]) ||
    DEFAULT_MIME_TYPE
  );
}

async function fetchMedia(
  url: string,
  source: Attachment,
  maxBytes: number,
): Promise<WAMessageMedia> {
  const response = await fetch(url, { signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    throw new ValidationError("wwebjs", `Could not fetch ${url}: HTTP ${response.status}.`);
  }
  const data = await collect(response.body, maxBytes, url);
  const name = source.name ?? new URL(url).pathname.split("/").pop() ?? null;
  const mimeType =
    source.mimeType ??
    response.headers.get("content-type")?.split(";")[0] ??
    mimeTypeOf(name ?? undefined);
  return new MessageMedia(mimeType, data.toString("base64"), name);
}

/** Reads at most `maxBytes`, stopping the stream rather than buffering the rest. */
async function collect(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw tooLarge(label, total, maxBytes);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function tooLarge(label: string, size: number, maxBytes: number): ValidationError {
  return new ValidationError(
    "wwebjs",
    `Media for ${label} is ${size} bytes or more, over the ${maxBytes}-byte limit.`,
  );
}

function unavailable(messageId: string): ValidationError {
  return new ValidationError(
    "wwebjs",
    `Media for message ${messageId} is no longer available for download.`,
  );
}

async function toBase64(data: ArrayBuffer | Blob | Buffer): Promise<string> {
  if (Buffer.isBuffer(data)) return data.toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  return Buffer.from(await data.arrayBuffer()).toString("base64");
}
