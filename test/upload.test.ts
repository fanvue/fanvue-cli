import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { loadCommands } from "../src/commands/registry.ts";
import { parseArgv } from "../src/runtime/argv.ts";
import { CliError } from "../src/runtime/errors.ts";
import { type Io, runCommand } from "../src/runtime/run.ts";
import { mediaTypeOf } from "../src/runtime/upload.ts";

const MEDIA = "0b4a3c1e-2f6d-4b8a-9c1d-5e7f8a9b0c1d";
const commands = await loadCommands();
const spec = (words: string) => {
  const found = commands.find((c) => c.command.join(" ") === words);
  if (!found) throw new Error(`no command ${words}`);
  return found;
};

type Seen = { method: string; path: string; auth: string | null; body: unknown; bytes?: number };
const seen: Seen[] = [];
let mediaPolls = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const raw = new Uint8Array(await req.arrayBuffer());
    const isJson = req.headers.get("content-type")?.includes("json");
    seen.push({
      method: req.method,
      path,
      auth: req.headers.get("authorization"),
      body: isJson ? JSON.parse(new TextDecoder().decode(raw)) : undefined,
      bytes: raw.length,
    });
    const route = `${req.method} ${url.pathname}`;
    if (route.endsWith("/media/uploads") && req.method === "POST") {
      return Response.json({
        mediaUuid: MEDIA,
        uploadId: "up~1",
        partSize: 10,
        maxParts: 256,
        totalParts: 3,
      });
    }
    if (url.pathname.endsWith("/parts/urls")) {
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const parts = Array.from({ length: to - from + 1 }, (_, i) => ({
        partNumber: from + i,
        url: `${server.url}s3/part${from + i}?X-Amz-Signature=abc`,
      }));
      return Response.json({ partSize: 10, parts });
    }
    if (url.pathname.startsWith("/s3/")) {
      return new Response(null, { headers: { ETag: `"etag-${url.pathname.slice(-1)}"` } });
    }
    if (route.endsWith("/media/uploads/up~1") && req.method === "PATCH") {
      return Response.json({ status: "processing" });
    }
    if (url.pathname.endsWith(`/media/${MEDIA}`)) {
      mediaPolls += 1;
      return Response.json({ uuid: MEDIA, status: mediaPolls < 2 ? "processing" : "ready" });
    }
    return Response.json({ ok: true, path: url.pathname });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0;
  mediaPolls = 0;
});

const FILE_SIZE = 25;
function makeIo(files: string[] = ["./photo.jpg"]) {
  const out: string[] = [];
  const io: Io = {
    stdout: (t) => out.push(t),
    stderr: () => {},
    interactive: false,
    terminalOutput: false,
    ask: async () => "",
    readFile: async () => "{}",
    openFile: async (path) =>
      files.includes(path)
        ? { size: FILE_SIZE, read: async (_start, length) => new Uint8Array(length) }
        : undefined,
    env: {},
  };
  return { io, out };
}
const transport = {
  baseUrl: server.url.toString(),
  sleep: async () => {},
  tokens: { token: async () => "test-token" },
};
const run = (words: string, args: string[], argv: string[], io: Io) =>
  runCommand(spec(words), args, parseArgv(argv).flags, io, transport);
const apiCalls = () =>
  seen.filter((s) => !s.path.startsWith("/s3/")).map((s) => `${s.method} ${s.path}`);

describe("mediaTypeOf", () => {
  test("from the extension, an override, or a clear error", () => {
    expect(mediaTypeOf("a/b/Clip.MOV")).toBe("video");
    expect(mediaTypeOf("note.m4a")).toBe("audio");
    expect(mediaTypeOf("file.bin", "document")).toBe("document");
    expect(() => mediaTypeOf("file.bin")).toThrow("Add --media-type");
  });
});

describe("vault media upload", () => {
  test("session, signed parts, PUTs without auth, complete with ETags, poll until ready", async () => {
    const { io, out } = makeIo();
    await run("vault media upload", ["./photo.jpg"], ["--yes", "--format", "json"], io);

    expect(apiCalls()).toEqual([
      "POST /v1/media/uploads",
      "GET /v1/media/uploads/up~1/parts/urls?from=1&to=3",
      "PATCH /v1/media/uploads/up~1",
      `GET /v1/media/${MEDIA}`,
      `GET /v1/media/${MEDIA}`,
    ]);
    expect(seen[0]?.body).toEqual({
      name: "photo.jpg",
      filename: "photo.jpg",
      mediaType: "image",
      sizeBytes: 25,
    });

    const puts = seen.filter((s) => s.path.startsWith("/s3/"));
    expect(puts.map((p) => p.bytes)).toEqual([10, 10, 5]);
    expect(puts.every((p) => p.auth === null)).toBe(true);

    const complete = seen.find((s) => s.method === "PATCH");
    expect(complete?.body).toEqual({
      parts: [
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
        { PartNumber: 3, ETag: '"etag-3"' },
      ],
    });
    expect(JSON.parse(out[0] as string)).toEqual({ mediaUuid: MEDIA, status: "ready" });
  });

  test("agencies upload through the creator routes", async () => {
    await run("vault media upload", ["./photo.jpg"], ["--yes", "--creator", "c-9"], makeIo().io);
    expect(apiCalls()[0]).toBe("POST /v1/creators/c-9/media/uploads");
  });

  test("a missing file is a usage error before anything is sent", async () => {
    const promise = run("vault media upload", ["./nope.jpg"], ["--yes"], makeIo([]).io);
    await expect(promise).rejects.toThrow("No file at ./nope.jpg.");
    expect(apiCalls()).toEqual([]);
  });
});

describe("--mediaUuids with a file path", () => {
  test("uploads the file, then sends the post with the new media UUID", async () => {
    const { io } = makeIo();
    await run(
      "posts create",
      [],
      ["--text", "New set", "--audience", "subscribers", "--mediaUuids", "./photo.jpg", "--yes"],
      io,
    );
    const post = seen.find((s) => s.method === "POST" && s.path === "/v1/posts");
    expect(post?.body).toEqual({ text: "New set", audience: "subscribers", mediaUuids: [MEDIA] });
    expect(apiCalls().indexOf(`GET /v1/media/${MEDIA}`)).toBeLessThan(
      apiCalls().indexOf("POST /v1/posts"),
    );
  });

  test("nothing uploads when the post isn't confirmed", async () => {
    const error = await run(
      "posts create",
      [],
      ["--text", "x", "--audience", "subscribers", "--mediaUuids", "./photo.jpg"],
      makeIo().io,
    ).catch((e: CliError) => e);
    expect(error instanceof CliError && error.code).toBe("confirmation_required");
    expect(seen).toHaveLength(0);
  });

  test("UUIDs and unknown values pass through untouched", async () => {
    await run(
      "posts create",
      [],
      ["--text", "x", "--audience", "subscribers", "--mediaUuids", MEDIA, "--yes"],
      makeIo().io,
    );
    expect(apiCalls()).toEqual(["POST /v1/posts"]);
  });
});
