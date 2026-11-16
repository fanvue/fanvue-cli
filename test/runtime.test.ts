import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Session } from "../src/auth/session.ts";
import { publicCommands } from "../src/commands/public.gen.ts";
import type { CommandSpec } from "../src/commands/types.ts";
import { parseArgv } from "../src/runtime/argv.ts";
import { CliError, EXIT } from "../src/runtime/errors.ts";
import { decideGate } from "../src/runtime/gate.ts";
import { render } from "../src/runtime/output.ts";
import { buildRawRequest } from "../src/runtime/raw.ts";
import { buildRequest } from "../src/runtime/request.ts";
import { formatOf, type Io, runCommand, runRaw } from "../src/runtime/run.ts";
import { memoryStore } from "./fixtures/file-store.ts";

const spec = (words: string) => {
  const found = publicCommands.find((c) => c.command.join(" ") === words);
  if (!found) throw new Error(`no command ${words}`);
  return found;
};
const flagsOf = (...argv: string[]) => parseArgv(argv).flags;

describe("parseArgv", () => {
  test("values, = syntax, repeats, switches and --", () => {
    const { words, flags } = parseArgv([
      "messages",
      "send",
      "fan-1",
      "--text",
      "hi there",
      "--price=500",
      "--mediaUuids",
      "a",
      "--mediaUuids",
      "b",
      "--yes",
      "--",
      "--not-a-flag",
    ]);
    expect(words).toEqual(["messages", "send", "fan-1", "--not-a-flag"]);
    expect(flags.get("text")).toEqual(["hi there"]);
    expect(flags.get("price")).toEqual(["500"]);
    expect(flags.get("mediaUuids")).toEqual(["a", "b"]);
    expect(flags.get("yes")).toEqual(["true"]);
  });

  test("a value flag at the end is an error", () => {
    expect(() => parseArgv(["posts", "list", "--size"])).toThrow("--size needs a value.");
  });
});

describe("buildRequest", () => {
  test("positional args fill the path and flags fill the body, with types", () => {
    const req = buildRequest(
      spec("messages send"),
      ["fan-1"],
      flagsOf("--text", "hi", "--price", "500", "--mediaUuids", "a", "--mediaUuids", "b"),
    );
    expect(req).toEqual({
      method: "POST",
      path: "/v1/chats/fan-1/message",
      query: [],
      body: { text: "hi", price: 500, mediaUuids: ["a", "b"] },
    });
  });

  test("--creator switches to the creator path", () => {
    const req = buildRequest(
      spec("fans subscribers list"),
      [],
      flagsOf("--creator", "c-9", "--size", "5"),
    );
    expect(req.path).toBe("/v1/creators/c-9/subscribers");
    expect(req.query).toEqual([["size", "5"]]);
  });

  test("--data is the base and flags override its fields", () => {
    const req = buildRequest(spec("messages send"), ["fan-1"], flagsOf("--text", "flag wins"), {
      text: "from data",
      price: 100,
    });
    expect(req.body).toEqual({ text: "flag wins", price: 100 });
  });

  test("usage errors carry a stable code, a JSON Pointer to the input, the value and a hint", () => {
    const caught = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        if (error instanceof CliError)
          return { exit: error.exitCode, code: error.code, ...error.detail };
      }
      throw new Error("expected a CliError");
    };
    expect(caught(() => buildRequest(spec("messages send"), [], flagsOf()))).toMatchObject({
      exit: EXIT.usage,
      code: "wrong_arguments",
      pointer: "/args",
      hint: "Usage: fanvue messages send <userUuid>",
    });
    expect(
      caught(() => buildRequest(spec("posts list"), [], flagsOf("--nope", "1"))),
    ).toMatchObject({
      code: "unknown_flag",
      pointer: "/flags/nope",
    });
    expect(
      caught(() => buildRequest(spec("messages send"), ["f"], flagsOf("--price", "lots"))),
    ).toMatchObject({ code: "invalid_type", pointer: "/body/price", value: "lots" });
    expect(
      caught(() => buildRequest(spec("posts list"), [], flagsOf("--size", "x"))),
    ).toMatchObject({
      pointer: "/query/size",
    });
    expect(
      caught(() => buildRequest(spec("account subscription-price set"), [], flagsOf())),
    ).toMatchObject({ code: "missing_flag", pointer: "/body/subscriptionPrice" });
    expect(
      caught(() => buildRequest(spec("account me"), [], flagsOf("--creator", "c"))),
    ).toMatchObject({
      code: "creator_not_supported",
      pointer: "/flags/creator",
    });
  });
});

describe("decideGate", () => {
  const base = { yes: false, confirm: undefined, interactive: false };
  test.each([
    ["read", base, "send"],
    ["write", base, "refuse"],
    ["write", { ...base, yes: true }, "send"],
    ["write", { ...base, interactive: true }, "ask-yes"],
    ["fan-facing", { ...base, yes: true }, "refuse"],
    ["fan-facing", { ...base, interactive: true }, "ask-handle"],
    ["fan-facing", { ...base, confirm: "@me" }, "check-handle"],
  ] as const)("%s %o → %s", (gate, input, kind) => {
    expect(decideGate({ gate, ...input }).kind).toBe(kind);
  });
});

describe("render", () => {
  test("hides tokens and signed links unless asked", () => {
    const value = {
      access_token: "secret",
      url: "https://media.fanvue.com/a.jpg?Expires=1&Signature=abc",
      plain: "https://fanvue.com/x",
    };
    expect(JSON.parse(render(value, "json"))).toEqual({
      access_token: "[hidden]",
      url: "[signed link hidden: add --show-url]",
      plain: "https://fanvue.com/x",
    });
    expect(JSON.parse(render(value, "json", true)).url).toContain("Signature=abc");
    expect(JSON.parse(render(value, "json", true)).access_token).toBe("[hidden]");
  });

  test("table and jsonl read a list response's data", () => {
    const page = {
      data: [
        { uuid: "1", handle: "a", nested: { x: 1 } },
        { uuid: "2", handle: "b" },
      ],
      nextCursor: null,
    };
    expect(render(page, "table")).toBe("uuid  handle\n1     a\n2     b");
    expect(render(page, "jsonl").split("\n")).toHaveLength(2);
    expect(render([], "table", false, "fanvue fans followers")).toBe(
      "No results for `fanvue fans followers`.",
    );
    expect(render([], "json")).toBe("[]");
  });

  test("a terminal on stdout gets a table even when stdin is piped; --json always wins", () => {
    expect(formatOf(flagsOf(), true)).toBe("table");
    expect(formatOf(flagsOf(), false)).toBe("json");
    expect(formatOf(flagsOf("--json"), true)).toBe("json");
  });
});

describe("buildRawRequest", () => {
  test("routes the CLI has a command for, and nothing else", () => {
    const { request, spec: matched } = buildRawRequest(
      ["get", "/v1/chats/fan-1/messages?size=2"],
      publicCommands,
    );
    expect(matched.command).toEqual(["messages", "read"]);
    expect(request.query).toEqual([["size", "2"]]);
    // Experience routes are excluded from the CLI, so the raw form can't reach them either.
    expect(() =>
      buildRawRequest(["POST", "/v1/experiences/request-token"], publicCommands),
    ).toThrow("isn't a Fanvue API route the CLI supports");
  });
});

// ---- end to end against a fake API ------------------------------------------------------

type Seen = { method: string; path: string; headers: Headers; body: unknown };
const seen: Seen[] = [];
let script: ((req: Request, url: URL) => Response | undefined) | undefined;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = await req.text();
    seen.push({
      method: req.method,
      path: url.pathname + url.search,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    const scripted = script?.(req, url);
    if (scripted) return scripted;
    if (url.pathname === "/v1/users/me") return Response.json({ uuid: "me-1", handle: "maya" });
    return Response.json({ ok: true, path: url.pathname });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0;
  script = undefined;
});

function makeIo(overrides: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    interactive: false,
    terminalOutput: false,
    ask: async () => "",
    readFile: async () => "{}",
    openFile: async () => undefined,
    env: { FANVUE_TOKEN: "test-token" },
    ...overrides,
  };
  return { io, out, err };
}
const transport = { baseUrl: server.url.toString(), sleep: async () => {} };
const run = (s: CommandSpec, args: string[], argv: string[], io: Io) =>
  runCommand(s, args, flagsOf(...argv), io, transport);
async function rejected(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("running commands", () => {
  test("a read sends the auth, version and user-agent headers", async () => {
    const { io, out } = makeIo();
    expect(await run(spec("posts list"), [], ["--size", "2"], io)).toBe(EXIT.ok);
    const [req] = seen;
    expect(req?.path).toBe("/v1/posts?size=2");
    expect(req?.headers.get("authorization")).toBe("Bearer test-token");
    expect(req?.headers.get("x-fanvue-api-version")).toBe("2025-06-26");
    expect(req?.headers.get("user-agent")).toMatch(/^fanvue-cli\//);
    expect(JSON.parse(out[0] as string)).toEqual({ ok: true, path: "/v1/posts" });
  });

  test("--all follows nextCursor", async () => {
    script = (_req, url) => {
      if (url.pathname !== "/v1/posts") return undefined;
      return url.searchParams.get("cursor") === "p2"
        ? Response.json({ data: [{ uuid: "b" }], nextCursor: null })
        : Response.json({ data: [{ uuid: "a" }], nextCursor: "p2" });
    };
    const { io, out } = makeIo();
    await run(spec("posts list"), [], ["--all"], io);
    expect(JSON.parse(out[0] as string)).toEqual([{ uuid: "a" }, { uuid: "b" }]);
    expect(seen.map((s) => s.path)).toEqual(["/v1/posts", "/v1/posts?cursor=p2"]);
  });

  test("429 is retried for reads, never for writes", async () => {
    let calls = 0;
    script = () =>
      calls++ === 0
        ? new Response("", { status: 429, headers: { "Retry-After": "1" } })
        : undefined;
    await run(spec("posts list"), [], [], makeIo().io);
    expect(seen).toHaveLength(2);

    seen.length = 0;
    calls = 0;
    const error = await rejected(
      run(
        spec("posts create"),
        [],
        ["--yes", "--text", "x", "--audience", "subscribers"],
        makeIo().io,
      ),
    );
    expect(error.message).toContain("429");
    expect(seen).toHaveLength(1);
  });

  test("a write without --yes and no terminal is refused before anything is sent", async () => {
    const error = await rejected(run(spec("posts delete"), ["p1"], [], makeIo().io));
    expect(error.exitCode).toBe(EXIT.needsHuman);
    expect(error.code).toBe("confirmation_required");
    expect(seen).toHaveLength(0);
  });

  test("never prompts by default, even at a terminal: refuses and names the flag", async () => {
    let asked = false;
    const ask = async () => {
      asked = true;
      return "y";
    };
    const io = makeIo({ interactive: true, ask }).io;
    const error = await rejected(run(spec("posts delete"), ["p1"], [], io));
    expect([error.exitCode, error.code, error.detail.hint]).toEqual([
      EXIT.needsHuman,
      "confirmation_required",
      "Re-run with --yes, or with --interactive to be asked.",
    ]);
    expect(asked).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("--interactive at a terminal asks, and only sends on yes", async () => {
    const ask = (answer: string) => makeIo({ interactive: true, ask: async () => answer }).io;
    await rejected(run(spec("posts delete"), ["p1"], ["--interactive"], ask("n")));
    expect(seen).toHaveLength(0);
    await run(spec("posts delete"), ["p1"], ["--interactive"], ask("y"));
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["DELETE /v1/posts/p1"]);
  });

  test("--interactive without a terminal still never prompts", async () => {
    const error = await rejected(run(spec("posts delete"), ["p1"], ["--interactive"], makeIo().io));
    expect(error.exitCode).toBe(EXIT.needsHuman);
  });

  test("writes carry an Idempotency-Key; reads don't", async () => {
    await run(spec("posts delete"), ["p1"], ["--yes"], makeIo().io);
    await run(spec("posts list"), [], [], makeIo().io);
    const [write, read] = seen;
    expect(write?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(read?.headers.get("idempotency-key")).toBeNull();
  });

  test("an error Fanvue blanked to a bare code says so and points at --schema", async () => {
    script = () => Response.json({ error: "BAD_REQUEST" }, { status: 400 });
    const error = await rejected(run(spec("posts list"), [], [], makeIo().io));
    expect([error.exitCode, error.code, error.detail.status]).toEqual([
      EXIT.unexpected,
      "bad_request",
      400,
    ]);
    expect(error.message).toBe("Fanvue rejected the request (BAD_REQUEST) without saying why.");
    expect(error.detail.hint).toContain("--schema");
  });

  test("Styx validation errors keep every message and point at the field", async () => {
    script = () =>
      Response.json(
        {
          errors: [
            { code: "invalid_type", message: "Invalid text: must be string, got number" },
            { code: "too_small", message: "Invalid mediaUuids: must contain at least 1 item(s)" },
          ],
        },
        { status: 400 },
      );
    const error = await rejected(
      run(
        spec("posts create"),
        [],
        ["--text", "x", "--audience", "subscribers", "--yes"],
        makeIo().io,
      ),
    );
    expect([error.exitCode, error.code, error.detail.pointer]).toEqual([
      EXIT.unexpected,
      "validation_failed",
      "/body/text",
    ]);
    expect(error.message).toBe(
      "Invalid text: must be string, got number; Invalid mediaUuids: must contain at least 1 item(s)",
    );
    expect(error.detail.errors).toHaveLength(2);
  });

  test("403 is an auth or scope problem (exit 4)", async () => {
    script = () => Response.json({ error: "Missing scope write:post" }, { status: 403 });
    const error = await rejected(run(spec("posts list"), [], [], makeIo().io));
    expect([error.exitCode, error.code, error.message]).toEqual([
      EXIT.auth,
      "forbidden",
      "Missing scope write:post",
    ]);
    expect(error.detail.scopes).toEqual(spec("posts list").scopes);
    expect(error.detail.hint).toContain("`fanvue login`");
  });

  test("a money route the CLI service refuses is not sent back to `fanvue login`", async () => {
    script = () =>
      Response.json(
        {
          error: "operation_excluded",
          message: "This operation moves money and is not available through the Fanvue CLI.",
        },
        { status: 403 },
      );
    const error = await rejected(run(spec("posts delete"), ["p1"], ["--yes"], makeIo().io));
    expect(error.code).toBe("operation_excluded");
    expect(error.message).toContain("moves money");
    expect(error.detail.hint).not.toContain("fanvue login");
  });

  test("a write's 403 points at `fanvue login --write`", async () => {
    script = () => Response.json({ error: "FORBIDDEN" }, { status: 403 });
    const error = await rejected(run(spec("posts delete"), ["p1"], ["--yes"], makeIo().io));
    expect(error.code).toBe("forbidden");
    expect(error.detail.hint).toContain("`fanvue login --write`");
  });

  test("404 is not_found, keeping Fanvue's sentence", async () => {
    script = () => Response.json({ message: "Post not found" }, { status: 404 });
    const error = await rejected(run(spec("posts get"), ["p1"], [], makeIo().io));
    expect([error.exitCode, error.code, error.message]).toEqual([
      EXIT.unexpected,
      "not_found",
      "Post not found",
    ]);
  });

  test("a 5xx says the problem is Fanvue's and to retry", async () => {
    script = () => Response.json({ message: "Service Unavailable" }, { status: 503 });
    const error = await rejected(run(spec("posts list"), [], [], makeIo().io));
    expect([error.code, error.detail.status]).toEqual(["server_error", 503]);
    expect(error.message).toBe("Fanvue had a problem answering (HTTP 503: Service Unavailable).");
    expect(error.detail.hint).toContain("Try again shortly");
  });

  test("a fan-facing write needs the right handle, --yes is not enough", async () => {
    const price = spec("account subscription-price set");
    await rejected(run(price, [], ["--yes", "--subscriptionPrice", "999"], makeIo().io));
    await rejected(
      run(price, [], ["--confirm", "@someone-else", "--subscriptionPrice", "999"], makeIo().io),
    );
    expect(seen.filter((s) => s.method === "PATCH")).toHaveLength(0);

    await run(price, [], ["--confirm", "@Maya", "--subscriptionPrice", "999"], makeIo().io);
    expect(seen.filter((s) => s.method === "PATCH").map((s) => s.body)).toEqual([
      { subscriptionPrice: 999 },
    ]);
  });

  test("creator-only routes fill in your own account id", async () => {
    await run(spec("fans blocks list"), [], [], makeIo().io);
    expect(seen.map((s) => s.path)).toEqual(["/v1/users/me", "/v1/creators/me-1/blocks"]);
  });

  test("--dry-run sends nothing and needs no token", async () => {
    const { io, out } = makeIo({ env: {} });
    await run(spec("messages send"), ["fan-1"], ["--text", "hi", "--dry-run"], io);
    expect(seen).toHaveLength(0);
    expect(out[0]).toBe(`POST ${server.url}v1/chats/fan-1/message`);
    expect(JSON.parse(out[1] as string)).toEqual({ text: "hi" });
  });

  test("--dry-run shows the CLI service, or Styx when a FANVUE_TOKEN is set", async () => {
    const withSession = makeIo({ env: {} });
    await runCommand(spec("posts list"), [], flagsOf("--dry-run"), withSession.io);
    expect(withSession.out[0]).toStartWith("GET https://cli.fanvue.com/v1/posts");
    const withToken = makeIo();
    await runCommand(spec("posts list"), [], flagsOf("--dry-run"), withToken.io);
    expect(withToken.out[0]).toStartWith("GET https://api.fanvue.com/v1/posts");
  });

  test("no session exits with auth_required before anything is sent", async () => {
    const session = new Session({
      store: memoryStore(),
      profile: "default",
      lockPath: "/tmp/fanvue-cli-unused.lock",
      refresh: async () => {
        throw new Error("unreachable");
      },
    });
    const tokens = { token: () => session.accessToken() };
    const error = await rejected(
      runCommand(spec("posts list"), [], flagsOf(), makeIo({ env: {} }).io, {
        ...transport,
        tokens,
      }),
    );
    expect([error.exitCode, error.code]).toEqual([EXIT.auth, "auth_required"]);
    expect(seen).toHaveLength(0);
  });

  test("a 401 refreshes once and retries with the new token", async () => {
    let calls = 0;
    script = () => (calls++ === 0 ? new Response("", { status: 401 }) : undefined);
    const rejectedTokens: string[] = [];
    const tokens = {
      token: async () => "old",
      after401: async (rejectedToken: string) => {
        rejectedTokens.push(rejectedToken);
        return "new";
      },
    };
    await runCommand(spec("posts list"), [], flagsOf(), makeIo().io, { ...transport, tokens });
    expect(rejectedTokens).toEqual(["old"]);
    expect(seen.map((s) => s.headers.get("authorization"))).toEqual(["Bearer old", "Bearer new"]);
  });

  test("a second 401, or a 401 with nothing to refresh, is auth_required", async () => {
    script = () => new Response("", { status: 401 });
    const tokens = { token: async () => "old", after401: async () => "new" };
    const twice = await rejected(
      runCommand(spec("posts list"), [], flagsOf(), makeIo().io, { ...transport, tokens }),
    );
    expect(twice.code).toBe("auth_required");
    expect(seen).toHaveLength(2);

    seen.length = 0;
    const devToken = await rejected(run(spec("posts list"), [], [], makeIo().io));
    expect(devToken.code).toBe("auth_required");
    expect(seen).toHaveLength(1);
  });

  test("fanvue api goes through the same confirmation gate", async () => {
    const error = await rejected(
      runRaw(["DELETE", "/v1/posts/p1"], flagsOf(), publicCommands, makeIo().io, transport),
    );
    expect(error.exitCode).toBe(EXIT.needsHuman);
    expect(seen).toHaveLength(0);
  });
});
