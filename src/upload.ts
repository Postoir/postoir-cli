import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { Client } from "./http.js";
import { PostoirError, safeMessage } from "./errors.js";

const MAX_BYTES = 100 * 1024 * 1024;
const HEADER_BYTES = 128 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 10_000;
const FFPROBE_OUTPUT_BYTES = 64 * 1024;

type Dimensions = { width: number; height: number; duration?: number };
type Reservation = {
  data?: { ticketId: string; uploadUrl: string; size: number; mimeType: string };
};

const extensionMimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function explicitNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extensionMimeType(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? undefined : extensionMimeTypes[fileName.slice(dot).toLowerCase()];
}

function supportedMimeType(mimeType: string): boolean {
  return Object.values(extensionMimeTypes).includes(mimeType);
}

function imageMimeType(header: Buffer): string | undefined {
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    return "image/jpeg";
  if (header.length >= 10 && header.subarray(0, 6).toString("ascii") === "GIF87a")
    return "image/gif";
  if (header.length >= 10 && header.subarray(0, 6).toString("ascii") === "GIF89a")
    return "image/gif";
  if (
    header.length >= 16 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

function imageDimensions(header: Buffer, mimeType: string): Dimensions {
  if (mimeType === "image/png") {
    if (header.length < 24)
      throw new PostoirError("INVALID_IMAGE", "Unable to read PNG dimensions");
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  }
  if (mimeType === "image/gif")
    return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
  if (mimeType === "image/webp") {
    const kind = header.subarray(12, 16).toString("ascii");
    if (kind === "VP8X" && header.length >= 30)
      return { width: 1 + header.readUIntLE(24, 3), height: 1 + header.readUIntLE(27, 3) };
    if (
      kind === "VP8 " &&
      header.length >= 30 &&
      header[23] === 0x9d &&
      header[24] === 0x01 &&
      header[25] === 0x2a
    )
      return { width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && header.length >= 25 && header[20] === 0x2f) {
      const bits = header.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    throw new PostoirError("INVALID_IMAGE", "Unable to read WebP dimensions");
  }
  for (let offset = 2; offset + 9 < header.length;) {
    if (header[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = header[offset + 1];
    offset += 2;
    while (marker === 0xff && offset < header.length) marker = header[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > header.length) break;
    const size = header.readUInt16BE(offset);
    if (size < 2 || offset + size > header.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    )
      return { height: header.readUInt16BE(offset + 3), width: header.readUInt16BE(offset + 5) };
    offset += size;
  }
  throw new PostoirError("INVALID_IMAGE", "Unable to read JPEG dimensions");
}

async function jpegDimensions(path: string, size: number): Promise<Dimensions> {
  const handle = await open(path, "r");
  const bytes = Buffer.alloc(5);
  try {
    let offset = 2;
    while (offset + 4 <= size) {
      await handle.read(bytes, 0, 2, offset);
      if (bytes[0] !== 0xff) {
        offset++;
        continue;
      }
      let marker = bytes[1];
      offset += 2;
      while (marker === 0xff && offset < size) {
        await handle.read(bytes, 0, 1, offset++);
        marker = bytes[0];
      }
      if (marker === 0xd8 || marker === 0xd9) continue;
      await handle.read(bytes, 0, 2, offset);
      const length = bytes.readUInt16BE(0);
      if (length < 2 || offset + length > size) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        await handle.read(bytes, 0, 5, offset + 2);
        return { height: bytes.readUInt16BE(1), width: bytes.readUInt16BE(3) };
      }
      offset += length;
    }
  } finally {
    await handle.close();
  }
  throw new PostoirError("INVALID_IMAGE", "Unable to read JPEG dimensions");
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const result = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(result, 0, result.length, 0);
    return result.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function probeVideo(path: string): Promise<Dimensions | undefined> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        "-i",
        resolvePath(path),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const finish = (value?: Dimensions, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const append = (chunk: Buffer, target: "out" | "err") => {
      const next = (target === "out" ? stdout : stderr) + chunk.toString();
      if (next.length > FFPROBE_OUTPUT_BYTES) {
        child.kill();
        finish(
          undefined,
          new PostoirError("FFPROBE_OUTPUT_TOO_LARGE", "ffprobe output exceeded the safety limit"),
        );
        return;
      }
      if (target === "out") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => append(chunk, "out"));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, "err"));
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") finish(undefined);
      else finish(undefined, new PostoirError("FFPROBE_FAILED", safeMessage(error)));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0)
        return finish(
          undefined,
          new PostoirError(
            "FFPROBE_FAILED",
            safeMessage(stderr || `ffprobe exited with status ${code}`),
          ),
        );
      try {
        const data = JSON.parse(stdout) as {
          streams?: Array<{ width?: number; height?: number }>;
          format?: { duration?: string };
        };
        const stream = data.streams?.[0];
        const width = stream?.width;
        const height = stream?.height;
        const duration = Number(data.format?.duration);
        if (!width || !height || !Number.isFinite(duration) || duration <= 0)
          throw new Error("ffprobe did not return usable video dimensions and duration");
        finish({ width, height, duration });
      } catch (error) {
        finish(undefined, new PostoirError("FFPROBE_FAILED", safeMessage(error)));
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined, new PostoirError("FFPROBE_TIMEOUT", "ffprobe timed out"));
    }, FFPROBE_TIMEOUT_MS);
  });
}

function signedStorageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PostoirError("UPLOAD_INVALID", "Server returned an invalid upload URL");
  }
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (!(url.protocol === "https:" || localHttp) || url.username || url.password)
    throw new PostoirError("UPLOAD_INVALID", "Server returned an unsafe upload URL");
  return url.href;
}

async function spoolStdin(
  metadata: Record<string, unknown>,
): Promise<{ path: string; fileName: string; cleanup: () => Promise<void> }> {
  const fileName = metadataString(metadata, "fileName");
  if (
    !fileName ||
    (!metadataString(metadata, "mimeType") && !metadataString(metadata, "contentType"))
  )
    throw new PostoirError("INVALID_STDIN", "stdin uploads require fileName and mimeType metadata");
  const directory = await mkdtemp(join(tmpdir(), "postoir-upload-"));
  const path = join(directory, "input");
  let size = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(
        size > MAX_BYTES
          ? new PostoirError("FILE_TOO_LARGE", "Media uploads are limited to 100 MiB")
          : undefined,
        chunk,
      );
    },
  });
  try {
    await pipeline(process.stdin, guard, createWriteStream(path, { flags: "wx" }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { path, fileName, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function ticketError(error: unknown, ticketId: string): PostoirError {
  if (error instanceof PostoirError) {
    (error as PostoirError & { details?: unknown }).details = {
      ...(typeof error.details === "object" && error.details
        ? (error.details as Record<string, unknown>)
        : {}),
      ticketId,
    };
    return error;
  }
  return new PostoirError("UPLOAD_FAILED", safeMessage(error), undefined, undefined, { ticketId });
}

/** Upload one supported image or video and create its Postoir media record. */
export async function uploadMedia(
  client: Client,
  inputPath: string,
  metadata: Record<string, unknown> = {},
): Promise<unknown> {
  const stdin = inputPath === "-" ? await spoolStdin(metadata) : undefined;
  const path = stdin?.path ?? inputPath;
  const fileName = stdin?.fileName ?? basename(path);
  try {
    const initial = await stat(path);
    if (!initial.isFile())
      throw new PostoirError("INVALID_FILE", "Upload input must be a regular file");
    if (!initial.size) throw new PostoirError("INVALID_FILE", "Upload input must not be empty");
    if (initial.size > MAX_BYTES)
      throw new PostoirError("FILE_TOO_LARGE", "Media uploads are limited to 100 MiB");
    const header = await readHeader(path);
    const detectedImageMime = imageMimeType(header);
    const requestedMime =
      metadataString(metadata, "mimeType") ??
      metadataString(metadata, "contentType") ??
      extensionMimeType(fileName);
    const mimeType = detectedImageMime ?? requestedMime;
    if (
      !mimeType ||
      !supportedMimeType(mimeType) ||
      (detectedImageMime && requestedMime && detectedImageMime !== requestedMime)
    )
      throw new PostoirError(
        "UNSUPPORTED_MEDIA",
        "Only JPEG, PNG, GIF, WebP, MP4, WebM, and QuickTime media are supported",
      );
    if (mimeType.startsWith("image/") && detectedImageMime !== mimeType)
      throw new PostoirError("INVALID_IMAGE", "The image content does not match its MIME type");
    let dimensions: Dimensions;
    if (mimeType.startsWith("image/")) {
      dimensions =
        mimeType === "image/jpeg"
          ? await jpegDimensions(path, initial.size)
          : imageDimensions(header, mimeType);
    } else {
      const probed = await probeVideo(path);
      const width = probed?.width ?? explicitNumber(metadata, "width");
      const height = probed?.height ?? explicitNumber(metadata, "height");
      const duration = probed?.duration ?? explicitNumber(metadata, "duration");
      if (!width || !height || !duration)
        throw new PostoirError(
          "VIDEO_METADATA_REQUIRED",
          "Video uploads require width, height, and duration when ffprobe is unavailable",
        );
      dimensions = { width, height, duration };
    }
    if (
      !Number.isInteger(dimensions.width) ||
      !Number.isInteger(dimensions.height) ||
      dimensions.width < 1 ||
      dimensions.height < 1
    )
      throw new PostoirError("INVALID_DIMENSIONS", "Media dimensions must be positive integers");
    const reservation = await client.request<Reservation>("POST", "/api/v1/media/uploads", {
      size: initial.size,
      mimeType,
      fileName,
    });
    const ticket = reservation.data;
    if (
      !ticket?.ticketId ||
      !ticket.uploadUrl ||
      ticket.size !== initial.size ||
      ticket.mimeType !== mimeType
    ) {
      if (ticket?.ticketId)
        await client
          .request("DELETE", `/api/v1/media/uploads/${encodeURIComponent(ticket.ticketId)}`)
          .catch(() => undefined);
      throw ticketError(
        new PostoirError("UPLOAD_INVALID", "Postoir could not prepare this upload"),
        ticket?.ticketId || "unavailable",
      );
    }
    try {
      const uploadUrl = signedStorageUrl(ticket.uploadUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
      try {
        let sent = 0;
        const guard = new Transform({
          transform(chunk, _encoding, callback) {
            sent += chunk.length;
            callback(
              sent > initial.size
                ? new PostoirError("FILE_CHANGED", "File changed during upload")
                : undefined,
              chunk,
            );
          },
          flush(callback) {
            callback(
              sent === initial.size
                ? undefined
                : new PostoirError("FILE_CHANGED", "File changed during upload"),
            );
          },
        });
        const source = createReadStream(path);
        source.on("error", (error) => guard.destroy(error));
        const body = source.pipe(guard);
        body.on("error", () => undefined);
        let response: Response;
        try {
          response = await fetch(uploadUrl, {
            method: "PUT",
            body: body as unknown as BodyInit,
            signal: controller.signal,
            redirect: "error",
            headers: { "content-type": mimeType, "content-length": String(initial.size) },
            duplex: "half",
          } as RequestInit);
        } finally {
          source.destroy();
          guard.destroy();
        }
        if (!response.ok)
          throw new PostoirError("UPLOAD_FAILED", `Upload failed (${response.status})`);
        const after = await stat(path);
        if (after.size !== initial.size)
          throw new PostoirError("FILE_CHANGED", "File changed during upload");
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      await client
        .request("DELETE", `/api/v1/media/uploads/${encodeURIComponent(ticket.ticketId)}`)
        .catch(() => undefined);
      throw ticketError(error, ticket.ticketId);
    }
    const title =
      metadataString(metadata, "title") ?? (fileName.replace(/\.[^.]+$/, "") || fileName);
    const finalBody: Record<string, unknown> = {
      uploadTicket: ticket.ticketId,
      title,
      width: dimensions.width,
      height: dimensions.height,
    };
    if (dimensions.duration !== undefined) finalBody.duration = dimensions.duration;
    const summary = metadataString(metadata, "summary");
    if (summary) finalBody.summary = summary;
    try {
      return await client.request("POST", "/api/v1/media", finalBody);
    } catch (error) {
      throw ticketError(error, ticket.ticketId);
    }
  } finally {
    await stdin?.cleanup();
  }
}
