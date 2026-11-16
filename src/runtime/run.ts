import { type TokenSource, tokenSourceFor } from "../auth/source.ts";
import { UPLOAD_OPERATION } from "../commands/handwritten.ts";
import type { CommandSpec } from "../commands/types.ts";
import { flag, has } from "./argv.ts";
import { ApiError, CliError, EXIT, UsageError, withScopes } from "./errors.ts";
import { decideGate, sameHandle } from "./gate.ts";
import { hostsFor } from "./hosts.ts";
import { type ClientOptions, send, sendAll, toUrl } from "./http.ts";
import { type Format, render } from "./output.ts";
import { buildRawRequest } from "./raw.ts";
import { type ApiRequest, buildRequest, SELF_PLACEHOLDER } from "./request.ts";
import { isUuid, MEDIA_FIELDS, mediaTypeOf, type UploadDeps, uploadMedia } from "./upload.ts";

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** True when a person is at the terminal and can answer a prompt. */
  interactive: boolean;
  /** True when stdout is a terminal: picks table output over JSON. */
  terminalOutput: boolean;
  ask: (question: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  /** A file to upload, or undefined when nothing is at that path. */
  openFile: (path: string) => Promise<UploadDeps["file"] | undefined>;
  env: Record<string, string | undefined>;
}

export type Transport = Pick<ClientOptions, "baseUrl" | "fetch" | "sleep"> & {
  tokens?: TokenSource;
};

type Flags = Map<string, string[]>;

async function readData(flags: Flags, io: Io): Promise<Record<string, unknown> | undefined> {
  const raw = flag(flags, "data");
  if (raw === undefined) return undefined;
  const text = raw.startsWith("@") ? await io.readFile(raw.slice(1)) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("--data must be a JSON object, or @file.json.", "invalid_json", {
      pointer: "/flags/data",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--data must be a JSON object, or @file.json.", "invalid_json", {
      pointer: "/flags/data",
    });
  }
  return parsed as Record<string, unknown>;
}

export function formatOf(flags: Flags, terminalOutput: boolean): Format {
  if (has(flags, "json")) return "json";
  const value = flag(flags, "format") ?? (terminalOutput ? "table" : "json");
  if (value !== "table" && value !== "json" && value !== "jsonl") {
    throw new UsageError("--format must be table, json or jsonl.", "invalid_value", {
      pointer: "/flags/format",
      value,
    });
  }
  return value;
}

/** Prompts only with --interactive at a real terminal; never by default. */
export const isInteractive = (flags: Flags, io: Pick<Io, "interactive">) =>
  io.interactive && has(flags, "interactive");

type Authed = <T>(call: (client: ClientOptions) => Promise<T>) => Promise<T>;

/**
 * Wraps API calls so a 401 triggers one refresh and one retry, as the API docs prescribe.
 * A second 401 surfaces as auth_required.
 */
async function authedClient(
  source: TokenSource,
  base: Omit<ClientOptions, "token">,
): Promise<Authed> {
  const client: ClientOptions = { ...base, token: await source.token() };
  return async (call) => {
    try {
      return await call(client);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401 && source.after401)) throw error;
      client.token = await source.after401(client.token);
      return call(client);
    }
  };
}

/** Fetches the acting account once: your own, or the creator's when --creator is set. */
function actorLoader(authed: Authed, creator: string | undefined) {
  let cached: Promise<{ uuid: string; handle: string }> | undefined;
  return () => {
    cached ??= authed(
      (client) =>
        send(
          {
            method: "GET",
            path: creator ? `/v1/creators/${encodeURIComponent(creator)}/account` : "/v1/users/me",
            query: [],
          },
          client,
          { retry429: true },
        ) as Promise<{ uuid: string; handle: string }>,
    );
    return cached;
  };
}

async function confirm(
  spec: CommandSpec,
  request: ApiRequest,
  flags: Flags,
  io: Io,
  actor: () => Promise<{ handle: string }>,
) {
  const decision = decideGate({
    gate: spec.gate,
    yes: has(flags, "yes", "y"),
    confirm: flag(flags, "confirm"),
    interactive: isInteractive(flags, io),
  });
  const what = `${spec.summary || spec.command.join(" ")} (${request.method} ${request.path})`;
  switch (decision.kind) {
    case "send":
      return;
    case "refuse":
      throw new CliError(decision.message, EXIT.needsHuman, "confirmation_required", {
        hint: decision.hint,
      });
    case "ask-yes": {
      const answer = await io.ask(`${what}\nContinue? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim()))
        throw new CliError("Cancelled.", EXIT.needsHuman, "cancelled");
      return;
    }
    case "ask-handle": {
      const { handle } = await actor();
      const typed = await io.ask(`${what}\nFans will see this. Type @${handle} to confirm: `);
      if (!sameHandle(typed, handle))
        throw new CliError("Handle didn't match. Cancelled.", EXIT.needsHuman, "cancelled");
      return;
    }
    case "check-handle": {
      const { handle } = await actor();
      if (!sameHandle(decision.handle, handle)) {
        throw new CliError(
          `--confirm ${decision.handle} doesn't match the account's handle.`,
          EXIT.needsHuman,
          "confirm_mismatch",
          { pointer: "/flags/confirm", value: decision.handle, hint: `Use --confirm @${handle}.` },
        );
      }
    }
  }
}

function printDryRun(
  request: ApiRequest,
  files: string[],
  baseUrl: string,
  io: Io,
  uploadOnly: boolean,
) {
  const override = uploadOnly ? (request.body?.mediaType as string | undefined) : undefined;
  for (const path of files) io.stdout(`Uploads ${path} first (${mediaTypeOf(path, override)})`);
  if (uploadOnly) return;
  const shown = request.path.replace(SELF_PLACEHOLDER, "<your account>");
  io.stdout(`${request.method} ${toUrl({ ...request, path: shown }, baseUrl)}`);
  if (request.body) io.stdout(JSON.stringify(request.body, null, 2));
}

async function execute(
  spec: CommandSpec,
  request: ApiRequest,
  flags: Flags,
  io: Io,
  transport: Transport,
  uploadFile?: string,
): Promise<number> {
  const format = formatOf(flags, io.terminalOutput);
  const hosts = hostsFor(io.env);
  const { tokens, ...http } = transport;
  // A FANVUE_TOKEN is a Fanvue token, which only Styx accepts; sessions go through the CLI service.
  const baseUrl = http.baseUrl ?? (io.env.FANVUE_TOKEN ? hosts.styx : hosts.api);
  const files = uploadFile ? [uploadFile] : await mediaFilesIn(request, io);

  if (has(flags, "dry-run")) {
    printDryRun(request, files, baseUrl, io, uploadFile !== undefined);
    return EXIT.ok;
  }

  const authed = await authedClient(tokens ?? tokenSourceFor(io.env, hosts), {
    ...http,
    baseUrl,
    ...(has(flags, "debug") ? { debug: io.stderr } : {}),
  });
  const actor = actorLoader(authed, flag(flags, "creator"));
  if (request.path.includes(SELF_PLACEHOLDER)) {
    request = { ...request, path: request.path.replace(SELF_PLACEHOLDER, (await actor()).uuid) };
  }

  await confirm(spec, request, flags, io, actor);

  const upload = uploaderFor(authed, http, io, flag(flags, "creator"));
  if (uploadFile) {
    const mediaUuid = await upload(uploadFile, request.body);
    io.stdout(render({ mediaUuid, status: "ready" }, format));
    return EXIT.ok;
  }
  if (files.length) request = await replaceMediaFiles(request, upload);

  const ready = request;
  const result = await authed((client) =>
    has(flags, "all") && spec.method === "GET"
      ? sendAll(ready, client)
      : send(ready, client, { retry429: spec.gate === "read" }),
  ).catch((error) => {
    throw withScopes(error, spec.scopes);
  });

  if (result && typeof result === "object" && "signingSecret" in result) {
    io.stderr("Save the signing secret now: Fanvue only shows it once.");
  }
  io.stdout(render(result, format, has(flags, "show-url"), `fanvue ${spec.command.join(" ")}`));
  return EXIT.ok;
}

/** Media fields whose values are file paths rather than UUIDs. Those files upload first. */
async function mediaFilesIn(request: ApiRequest, io: Io): Promise<string[]> {
  const values = Object.entries(request.body ?? {})
    .filter(([key]) => MEDIA_FIELDS.test(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter((v): v is string => typeof v === "string" && !isUuid(v));
  const found = await Promise.all(
    values.map(async (v) => ((await io.openFile(v)) ? v : undefined)),
  );
  return found.filter((v): v is string => v !== undefined);
}

type Upload = (path: string, body?: Record<string, unknown>) => Promise<string>;

function uploaderFor(
  authed: Authed,
  http: Omit<Transport, "tokens">,
  io: Io,
  creator: string | undefined,
): Upload {
  const doFetch = http.fetch ?? fetch;
  return async (path, body) => {
    const file = await io.openFile(path);
    if (!file) throw new UsageError(`No file at ${path}.`);
    return uploadMedia(
      {
        path,
        ...(typeof body?.name === "string" ? { name: body.name } : {}),
        ...(typeof body?.mediaType === "string" ? { mediaType: body.mediaType } : {}),
        ...(creator ? { creator } : {}),
      },
      {
        api: (r) => authed((client) => send(r, client, { retry429: r.method === "GET" })),
        putPart: async (url, bytes) => {
          const res = await doFetch(url, { method: "PUT", body: bytes });
          if (!res.ok) throw new CliError(`Uploading part of ${path} failed (${res.status}).`);
          return res.headers.get("etag") ?? "";
        },
        file,
        ...(http.sleep ? { sleep: http.sleep } : {}),
        ...(io.interactive ? { progress: io.stderr } : {}),
      },
    );
  };
}

async function replaceMediaFiles(request: ApiRequest, upload: Upload): Promise<ApiRequest> {
  const swap = async (value: unknown) =>
    typeof value === "string" && !isUuid(value)
      ? upload(value).catch(rethrowUnlessMissing(value))
      : value;
  const body: Record<string, unknown> = { ...request.body };
  for (const [key, value] of Object.entries(body)) {
    if (!MEDIA_FIELDS.test(key)) continue;
    body[key] = Array.isArray(value) ? await Promise.all(value.map(swap)) : await swap(value);
  }
  return { ...request, body };
}

// A non-UUID value that isn't a file is left for the API to reject with its own message.
const rethrowUnlessMissing = (value: string) => (error: unknown) => {
  if (error instanceof UsageError && error.message === `No file at ${value}.`) return value;
  throw error;
};

export async function runCommand(
  spec: CommandSpec,
  positionals: string[],
  flags: Flags,
  io: Io,
  transport: Transport = {},
): Promise<number> {
  const request = buildRequest(spec, positionals, flags, await readData(flags, io));
  const uploadFile = spec.operationId === UPLOAD_OPERATION ? positionals[0] : undefined;
  return execute(spec, request, flags, io, transport, uploadFile);
}

export async function runRaw(
  words: string[],
  flags: Flags,
  commands: CommandSpec[],
  io: Io,
  transport: Transport = {},
): Promise<number> {
  const { spec, request } = buildRawRequest(words, commands, await readData(flags, io));
  return execute(spec, request, flags, io, transport);
}
