import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/auth/lock.ts";
import { logout } from "../src/auth/logout.ts";
import { refreshTokens, revokeRefreshToken } from "../src/auth/oauth.ts";
import { Session } from "../src/auth/session.ts";
import { sessionFor } from "../src/auth/source.ts";
import type { TokenSet, TokenStore } from "../src/auth/tokens.ts";
import { CliError, EXIT } from "../src/runtime/errors.ts";
import { startFakeHydra } from "./fixtures/fake-hydra.ts";
import { fileStore, memoryStore } from "./fixtures/file-store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "fanvue-cli-test-"));
const expired: TokenSet = { accessToken: "a0", refreshToken: "r0", expiresAt: 0, scope: "" };

function sessionWith(store: TokenStore, tokenUrl: string, now?: () => number) {
  return new Session({
    store,
    profile: "default",
    lockPath: join(tmp(), "refresh.lock"),
    refresh: (current) =>
      refreshTokens(
        { tokenUrl, clientId: "fanvue-cli", ...(now ? { now } : {}) },
        current.refreshToken,
      ),
    ...(now ? { now } : {}),
  });
}

async function rejected(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a CliError");
}

describe("Session", () => {
  test("a token with more than five minutes left is used as is", async () => {
    const hydra = startFakeHydra();
    const store = memoryStore({ ...expired, expiresAt: Date.now() + 10 * 60_000 });
    expect(await sessionWith(store, hydra.url).accessToken()).toBe("a0");
    expect(hydra.state.refreshes).toBe(0);
    hydra.stop();
  });

  test("an expiring token refreshes, and the new pair is saved", async () => {
    const hydra = startFakeHydra();
    const store = memoryStore(expired);
    expect(await sessionWith(store, hydra.url).accessToken()).toBe("a1");
    expect(store.value?.refreshToken).toBe("r1");
    hydra.stop();
  });

  test("invalid_grant ends the session: tokens are deleted and the user is sent to login", async () => {
    const hydra = startFakeHydra();
    const store = memoryStore({ ...expired, refreshToken: "never-issued" });
    const error = await rejected(sessionWith(store, hydra.url).accessToken());
    expect([error.exitCode, error.code]).toEqual([EXIT.auth, "auth_required"]);
    expect(store.value).toBeUndefined();
    hydra.stop();
  });

  test("after a 401 it refreshes even a token that looks valid", async () => {
    const hydra = startFakeHydra();
    const store = memoryStore({ ...expired, expiresAt: Date.now() + 60 * 60_000 });
    expect(await sessionWith(store, hydra.url).accessTokenAfter401("a0")).toBe("a1");
    hydra.stop();
  });

  test("after a 401 it reuses a token another process already refreshed", async () => {
    const hydra = startFakeHydra();
    const store = memoryStore({ ...expired, accessToken: "a7", refreshToken: "r7" });
    expect(await sessionWith(store, hydra.url).accessTokenAfter401("a0")).toBe("a7");
    expect(hydra.state.refreshes).toBe(0);
    hydra.stop();
  });

  test("a refresh response without a new refresh token keeps the old one", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ access_token: "a1", expires_in: 3600 }),
    });
    const store = memoryStore(expired);
    expect(await sessionWith(store, `${server.url}oauth2/token`).accessToken()).toBe("a1");
    expect(store.value?.refreshToken).toBe("r0");
    server.stop(true);
  });

  test("refresh uses the client the session was issued to, and keeps it", async () => {
    let clientId: string | null | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        clientId = new URLSearchParams(await req.text()).get("client_id");
        return Response.json({ access_token: "a1", refresh_token: "r1", expires_in: 3600 });
      },
    });
    const store = memoryStore({ ...expired, clientId: "my-dev-app" });
    const hosts = {
      api: "http://unused",
      auth: server.url.toString().replace(/\/$/, ""),
      styx: "http://unused",
    };
    const session = sessionFor({ HOME: tmp(), XDG_CONFIG_HOME: tmp() }, hosts, store);
    expect(await session.accessToken()).toBe("a1");
    expect(clientId).toBe("my-dev-app");
    expect(store.value?.clientId).toBe("my-dev-app");
    server.stop(true);
  });

  test("a rejected client is a clean auth_required, not a crash", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "invalid_client" }, { status: 401 }),
    });
    const store = memoryStore(expired);
    const error = await rejected(sessionWith(store, `${server.url}oauth2/token`).accessToken());
    expect([error.exitCode, error.code]).toEqual([EXIT.auth, "auth_required"]);
    expect(error.detail.hint).toBe("Run `fanvue login`.");
    expect(store.value?.refreshToken).toBe("r0");
    server.stop(true);
  });

  test("not logged in", async () => {
    const error = await rejected(sessionWith(memoryStore(), "http://unused").accessToken());
    expect(error.code).toBe("auth_required");
  });
});

describe("crash between the refresh response and saving it", () => {
  // The server has rotated r0 to r1, but r1 died with the process. The next run can only
  // present r0 again; the token endpoint's 30 s grace window decides whether that recovers.
  async function crashThenRetryAfter(elapsedMs: number) {
    let clock = 1_000_000;
    const now = () => clock;
    const hydra = startFakeHydra({ graceMs: 30_000, now });
    const store = memoryStore(expired);
    const crashing: TokenStore = {
      ...store,
      set: async () => {
        throw new Error("process killed");
      },
    };
    await expect(sessionWith(crashing, hydra.url, now).accessToken()).rejects.toThrow(
      "process killed",
    );
    expect(store.value?.refreshToken).toBe("r0");

    clock += elapsedMs;
    const result = await sessionWith(store, hydra.url, now)
      .accessToken()
      .catch((error: CliError) => error);
    hydra.stop();
    return { result, store };
  }

  test("inside the grace window, the next run recovers with a new pair", async () => {
    const { result, store } = await crashThenRetryAfter(5_000);
    expect(result).toBe("a2");
    expect(store.value?.refreshToken).toBe("r2");
  });

  test("after the grace window, the session ends cleanly with auth_required, not a loop", async () => {
    const { result, store } = await crashThenRetryAfter(31_000);
    expect(result instanceof CliError && result.code).toBe("auth_required");
    expect(store.value).toBeUndefined();
  });
});

describe("two processes refreshing at the same time", () => {
  async function race(withLockFile: boolean) {
    const dir = tmp();
    const storePath = join(dir, "tokens.json");
    await fileStore(storePath).set("default", expired);
    // No grace window and a slow token endpoint, so both requests are in flight together.
    const hydra = startFakeHydra({ delayMs: 300 });
    const env = {
      ...process.env,
      STORE_PATH: storePath,
      LOCK_PATH: join(dir, "refresh.lock"),
      TOKEN_URL: hydra.url,
      ...(withLockFile ? {} : { NO_LOCK: "1" }),
    };
    const worker = new URL("./fixtures/refresh-worker.ts", import.meta.url).pathname;
    const procs = [0, 1].map(() => Bun.spawn(["bun", "run", worker], { env, stdout: "pipe" }));
    const outputs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    const codes = await Promise.all(procs.map((p) => p.exited));
    const result = { codes, outputs: outputs.map((o) => o.trim()), ...hydra.state };
    hydra.stop();
    return result;
  }

  test("with the lock: one refresh, both processes get the new token", async () => {
    const result = await race(true);
    expect(result).toMatchObject({
      codes: [0, 0],
      outputs: ["a1", "a1"],
      refreshes: 1,
      revoked: false,
    });
  });

  test("without the lock the session gets revoked, which is what the lock prevents", async () => {
    const result = await race(false);
    expect(result.revoked).toBe(true);
    expect(result.codes).toContain(1);
  });
});

describe("logout", () => {
  const revocation = (status: number) => {
    const forms: URLSearchParams[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        forms.push(new URLSearchParams(await req.text()));
        return new Response(null, { status });
      },
    });
    const revoke = (tokens: TokenSet) =>
      revokeRefreshToken(
        { revocationUrl: `${server.url}oauth2/revoke`, clientId: "fanvue-cli" },
        tokens.refreshToken,
      );
    return { forms, revoke, stop: () => server.stop(true) };
  };

  test("revokes the refresh token, then removes the stored session", async () => {
    const service = revocation(200);
    const store = memoryStore(expired);
    expect(await logout(store, "default", service.revoke)).toBe(true);
    expect(Object.fromEntries(service.forms[0] ?? [])).toEqual({
      token: "r0",
      token_type_hint: "refresh_token",
      client_id: "fanvue-cli",
    });
    expect(store.value).toBeUndefined();
    expect(await logout(store, "default", service.revoke)).toBe(false);
    expect(service.forms).toHaveLength(1);
    service.stop();
  });

  test("a 5xx keeps the session so logout can be retried", async () => {
    const service = revocation(503);
    const store = memoryStore(expired);
    const error = await rejected(logout(store, "default", service.revoke));
    expect(error.code).toBe("server_error");
    expect(store.value?.refreshToken).toBe("r0");
    service.stop();
  });
});

describe("withLock", () => {
  test("takes over a lock left behind by a dead process", async () => {
    const path = join(tmp(), "refresh.lock");
    writeFileSync(path, "99999 0");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(await withLock(path, async () => "ran")).toBe("ran");
    expect(existsSync(path)).toBe(false);
  });
});
