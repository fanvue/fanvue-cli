import { basename, extname } from "node:path";
import { CliError, UsageError } from "./errors.ts";
import type { ApiRequest } from "./request.ts";

export type MediaType = "image" | "video" | "audio" | "document";

const BY_EXTENSION: Record<string, MediaType> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".webp": "image",
  ".heic": "image",
  ".mp4": "video",
  ".mov": "video",
  ".m4v": "video",
  ".webm": "video",
  ".mp3": "audio",
  ".m4a": "audio",
  ".wav": "audio",
  ".aac": "audio",
  ".ogg": "audio",
  ".pdf": "document",
};

export function mediaTypeOf(path: string, override?: string): MediaType {
  const type = override ?? BY_EXTENSION[extname(path).toLowerCase()];
  if (type === "image" || type === "video" || type === "audio" || type === "document") return type;
  throw new UsageError(
    `Can't tell the media type of ${basename(path)}. Add --media-type image|video|audio|document.`,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

export interface UploadDeps {
  /** Sends an authenticated API request and returns the parsed body. */
  api: (request: ApiRequest) => Promise<unknown>;
  /** PUTs bytes to a signed part URL and returns the ETag header. No Authorization header. */
  putPart: (url: string, bytes: Uint8Array) => Promise<string>;
  file: { size: number; read: (start: number, length: number) => Promise<Uint8Array> };
  sleep?: (ms: number) => Promise<void>;
  progress?: (line: string) => void;
}

export interface UploadOptions {
  path: string;
  name?: string;
  mediaType?: string;
  /** Agencies upload into a creator's media through the creator-scoped routes. */
  creator?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

// Sign a few parts at a time: signed URLs expire, so a slow upload shouldn't sign them all up front.
const SIGN_BATCH = 10;

/**
 * Uploads a file to the creator's media in parts and waits until it is ready to attach:
 * create session, sign parts, PUT each part, complete, poll. Returns the media UUID.
 */
export async function uploadMedia(options: UploadOptions, deps: UploadDeps): Promise<string> {
  const { path, creator, pollIntervalMs = 1500, pollTimeoutMs = 300_000 } = options;
  const prefix = creator ? `/v1/creators/${encodeURIComponent(creator)}` : "/v1";
  const sleep = deps.sleep ?? Bun.sleep;
  const { size } = deps.file;
  const filename = basename(path);

  const session = (await deps.api({
    method: "POST",
    path: `${prefix}/media/uploads`,
    query: [],
    body: {
      name: options.name ?? filename,
      filename,
      mediaType: mediaTypeOf(path, options.mediaType),
      sizeBytes: size,
    },
  })) as { mediaUuid: string; uploadId: string; partSize: number; totalParts: number | null };
  const totalParts = session.totalParts ?? Math.ceil(size / session.partSize);
  const uploadPath = `${prefix}/media/uploads/${encodeURIComponent(session.uploadId)}`;

  const parts: { PartNumber: number; ETag: string }[] = [];
  for (let from = 1; from <= totalParts; from += SIGN_BATCH) {
    const to = Math.min(from + SIGN_BATCH - 1, totalParts);
    const signed = (await deps.api({
      method: "GET",
      path: `${uploadPath}/parts/urls`,
      query: [
        ["from", String(from)],
        ["to", String(to)],
      ],
    })) as { parts: { partNumber: number; url: string }[] };
    for (const { partNumber, url } of signed.parts) {
      const start = (partNumber - 1) * session.partSize;
      const bytes = await deps.file.read(start, Math.min(session.partSize, size - start));
      parts.push({ PartNumber: partNumber, ETag: await deps.putPart(url, bytes) });
      deps.progress?.(`Uploaded part ${partNumber} of ${totalParts}`);
    }
  }

  await deps.api({ method: "PATCH", path: uploadPath, query: [], body: { parts } });

  const mediaPath = `${prefix}/media/${encodeURIComponent(session.mediaUuid)}`;
  for (let waited = 0; ; waited += pollIntervalMs) {
    const media = (await deps.api({ method: "GET", path: mediaPath, query: [] })) as {
      status?: string;
      errorReason?: string;
    };
    if (media.status === "ready") return session.mediaUuid;
    if (media.status === "error") {
      throw new CliError(`Fanvue couldn't process ${filename}: ${media.errorReason ?? "unknown"}.`);
    }
    if (waited >= pollTimeoutMs) {
      throw new CliError(
        `${filename} is still processing. Check it later with \`fanvue vault media get ${session.mediaUuid}\`.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/** Body fields that hold media UUIDs. A file path there is uploaded first. */
export const MEDIA_FIELDS = /^(mediaUuids?|mediaPreviewUuid)$/;
