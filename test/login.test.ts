import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { login } from "../src/auth/login.ts";
import { scopesFor } from "../src/auth/scopes.ts";
import { publicCommands } from "../src/commands/public.gen.ts";
import { CliError } from "../src/runtime/errors.ts";
import { memoryStore } from "./fixtures/file-store.ts";

let authorizeParams: URLSearchParams | undefined;
let account: { handle: string; roles: string[] } = { handle: "maya", roles: ["creator"] };
let exchanges = 0;
/** The page the browser tab showed for the last callback. */
let lastPage: Promise<{ status: number; text: string }> | undefined;

// Plays the CLI service's token endpoint and its /v1/users/me.
const server = Bun.serve({
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/oauth2/token") {
      exchanges += 1;
      const form = new URLSearchParams(await req.text());
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      const ok =
        form.get("grant_type") === "authorization_code" &&
        form.get("code") === "code-1" &&
        form.get("redirect_uri") === authorizeParams?.get("redirect_uri") &&
        challenge === authorizeParams?.get("code_challenge");
      if (!ok) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: authorizeParams?.get("scope"),
      });
    }
    if (url.pathname === "/v1/users/me") return Response.json(account);
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  authorizeParams = undefined;
  account = { handle: "maya", roles: ["creator"] };
  exchanges = 0;
  lastPage = undefined;
});

const hosts = {
  api: server.url.toString().replace(/\/$/, ""),
  auth: server.url.toString().replace(/\/$/, ""),
  styx: "http://unused",
};

/** A browser that approves and follows the redirect, optionally tampering with it. */
const browser =
  (tamper: (callback: URL) => void = () => {}) =>
  async (url: string) => {
    authorizeParams = new URL(url).searchParams;
    const callback = new URL(authorizeParams.get("redirect_uri") as string);
    callback.searchParams.set("code", "code-1");
    callback.searchParams.set("state", authorizeParams.get("state") as string);
    tamper(callback);
    // A browser renders the page whenever it arrives; it never holds up the terminal.
    lastPage = fetch(callback).then(async (res) => ({
      status: res.status,
      text: await res.text(),
    }));
    return true;
  };

const run = (overrides: Partial<Parameters<typeof login>[0]> = {}) => {
  const store = memoryStore();
  const promise = login({
    hosts,
    clientId: "fanvue-cli",
    write: false,
    store,
    sessionKey: "default",
    openBrowser: browser(),
    print: () => {},
    timeoutMs: 5_000,
    ...overrides,
  });
  return { promise, store };
};

describe("login", () => {
  test("PKCE code flow on loopback stores the session", async () => {
    const { promise, store } = run();
    expect(await promise).toEqual({
      handle: "maya",
      scope: "openid offline_access fanvue_cli:read",
    });
    expect(store.value).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      clientId: "fanvue-cli",
    });

    expect(authorizeParams?.get("client_id")).toBe("fanvue-cli");
    expect(authorizeParams?.get("code_challenge_method")).toBe("S256");
    expect(authorizeParams?.get("prompt")).toBe("consent");
    expect(authorizeParams?.get("resource")).toBe(hosts.api);
    expect(authorizeParams?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  test("read access by default; --write adds fanvue_cli:write", async () => {
    await run().promise;
    expect(authorizeParams?.get("scope")?.split(" ")).toEqual([
      "openid",
      "offline_access",
      "fanvue_cli:read",
    ]);
    await run({ write: true }).promise;
    expect(authorizeParams?.get("scope")?.split(" ")).toEqual([
      "openid",
      "offline_access",
      "fanvue_cli:read",
      "fanvue_cli:write",
    ]);
  });

  test("a response for a different login is rejected before any exchange", async () => {
    const { promise, store } = run({
      openBrowser: browser((cb) => cb.searchParams.set("state", "someone-elses")),
    });
    await expect(promise).rejects.toThrow("didn't match this login");
    expect(exchanges).toBe(0);
    expect(store.value).toBeUndefined();
  });

  test("the browser sees why the sign-in failed, not a dropped connection", async () => {
    let page = { status: 0, text: "" };
    const { promise } = run({
      openBrowser: async (url) => {
        authorizeParams = new URL(url).searchParams;
        const callback = new URL(authorizeParams.get("redirect_uri") as string);
        callback.searchParams.set("state", authorizeParams.get("state") as string);
        callback.searchParams.set("error", "invalid_scope");
        callback.searchParams.set("error_description", "The requested scope is invalid");
        const res = await fetch(callback);
        page = { status: res.status, text: await res.text() };
        return true;
      },
    });
    await expect(promise).rejects.toThrow("The requested scope is invalid");
    expect(page.status).toBe(400);
    expect(page.text).toContain("invalid_scope");
  });

  test("the browser names the signed-in account and its access", async () => {
    const { promise } = run({ write: true });
    await promise;
    const shown = await lastPage;
    expect(shown?.status).toBe(200);
    expect(shown?.text).toContain("<strong>@maya</strong> with read and write access");
  });

  test("the browser shows why a sign-in failed after the code arrived", async () => {
    account = { handle: "a-fan", roles: [] };
    const { promise } = run();
    await promise.catch(() => {});
    const shown = await lastPage;
    expect(shown?.status).toBe(400);
    expect(shown?.text).toContain("The Fanvue CLI is for creator and agency accounts.");
  });

  test("an account handle is escaped on the page", async () => {
    account = { handle: "<b>x</b>", roles: ["creator"] };
    const { promise } = run();
    await promise;
    expect((await lastPage)?.text).toContain("@&#60;b&#62;x&#60;/b&#62;");
  });

  test("a refused consent ends the login with auth_required", async () => {
    const { promise } = run({
      openBrowser: browser((cb) => {
        cb.searchParams.delete("code");
        cb.searchParams.set("error", "access_denied");
      }),
    });
    const error = await promise.catch((e: CliError) => e);
    expect(error instanceof CliError && error.code).toBe("auth_required");
    expect(exchanges).toBe(0);
  });

  test("a fan-only account is refused and nothing is stored", async () => {
    account = { handle: "a-fan", roles: [] };
    const { promise, store } = run();
    await expect(promise).rejects.toThrow("for creator and agency accounts");
    expect(store.value).toBeUndefined();
  });

  test("agency accounts are accepted", async () => {
    account = { handle: "agency-1", roles: ["agency_admin"] };
    expect((await run().promise).handle).toBe("agency-1");
  });

  test("listens on a free port the OS picks, so a busy port never blocks login", async () => {
    await run().promise;
    const first = authorizeParams?.get("redirect_uri");
    const busy = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(first as string).port),
      fetch: () => new Response(),
    });
    try {
      await run().promise;
      expect(authorizeParams?.get("redirect_uri")).not.toBe(first);
    } finally {
      busy.stop(true);
    }
  });
});

describe("scopes", () => {
  test("fanvue_cli:write reaches every Fanvue scope a command needs", () => {
    // The service grants each read:* and write:* scope except write:payments.
    const needed = new Set(publicCommands.flatMap((c) => c.scopes));
    expect(scopesFor(true)).toContain("fanvue_cli:write");
    for (const scope of needed) {
      expect(scope).toMatch(/^(read|write):/);
      expect(scope).not.toBe("write:payments");
    }
  });
});
