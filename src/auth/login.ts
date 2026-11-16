import { CliError, EXIT } from "../runtime/errors.ts";
import type { Hosts } from "../runtime/hosts.ts";
import { VERSION } from "../version.ts";
import { createPkce } from "./pkce.ts";
import { SUPPORTED_ROLES, scopesFor } from "./scopes.ts";
import type { TokenSet, TokenStore } from "./tokens.ts";

export interface LoginOptions {
  hosts: Hosts;
  clientId: string;
  write: boolean;
  store: TokenStore;
  sessionKey: string;
  /** Opens the authorisation URL in a browser. Returns false when it couldn't. */
  openBrowser: (url: string) => Promise<boolean>;
  print: (line: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** How the login ended, shown on the browser tab that delivered the code. */
type Outcome = { ok: true; handle: string; write: boolean } | { ok: false; reason: string };

interface Callback {
  url: string;
  code: Promise<string>;
  /** Settles the page the browser is waiting on. Only the first call counts. */
  finish: (outcome: Outcome) => void;
  stop: () => void;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page on the browser tab that delivered the code: a heading and one or two lines, in the
 * browser's light or dark scheme.
 */
function page(title: string, lines: string[], status: number): Response {
  const body = lines.map((line) => `<p>${line}</p>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Fanvue CLI</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#141414;--muted:#5c5c5c;--ok:#1f9d55;--bad:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f0f;--card:#1a1a1a;--fg:#f2f2f2;--muted:#a3a3a3;--ok:#34d399;--bad:#fb923c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;
background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:100%;max-width:420px;background:var(--card);border-radius:16px;padding:32px;box-shadow:0 1px 3px rgb(0 0 0/.08)}
.brand{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 16px}
h1{font-size:22px;margin:0 0 8px;color:${status < 400 ? "var(--ok)" : "var(--bad)"}}
p{margin:8px 0 0;color:var(--muted)}strong{color:var(--fg)}
</style></head><body><main><p class="brand">Fanvue CLI</p><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * Listens for exactly one redirect on a port the OS picks. The service accepts `127.0.0.1` on any
 * port for its native client (RFC 8252 section 7.3), but not `localhost`.
 */
function listen(state: string, timeoutMs: number): Callback {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The browser can answer before login() awaits this, so mark it handled; the caller still
  // sees the rejection when it awaits.
  code.catch(() => {});

  // The success page waits for the exchange and the account check, so it can name the account.
  let finish!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return page("Not found", [], 404);
      const error = url.searchParams.get("error");
      if (url.searchParams.get("state") !== state) {
        settle.reject(
          new CliError(
            "Login failed: the response didn't match this login. Run `fanvue login` again.",
          ),
        );
        return page(
          "Sign-in didn't match",
          ["This sign-in didn't match the one your terminal started. Nothing was saved."],
          400,
        );
      }
      if (error) {
        const reason = url.searchParams.get("error_description") ?? error;
        settle.reject(
          new CliError(`Login was cancelled or refused: ${reason}`, EXIT.auth, "auth_required", {
            value: error,
          }),
        );
        return page(
          "Sign-in didn't complete",
          [`${escapeHtml(reason)} (${escapeHtml(error)}).`, "Nothing was saved."],
          400,
        );
      }
      const received = url.searchParams.get("code");
      if (!received) return page("Sign-in didn't complete", ["Fanvue sent no code."], 400);
      settle.resolve(received);
      return outcome.then((result) =>
        result.ok
          ? page(
              "You're signed in",
              [
                `Signed in as <strong>@${escapeHtml(result.handle)}</strong> with ${result.write ? "read and write" : "read"} access.`,
                "You can close this tab and go back to your terminal.",
              ],
              200,
            )
          : page("Sign-in didn't complete", [escapeHtml(result.reason), "Nothing was saved."], 400),
      );
    },
  });
  const timer = setTimeout(
    () =>
      settle.reject(
        new CliError("Login timed out. Run `fanvue login` again.", EXIT.auth, "auth_required"),
      ),
    timeoutMs,
  );
  return {
    url: `http://127.0.0.1:${server.port}/callback`,
    code,
    finish,
    stop: () => {
      clearTimeout(timer);
      // Graceful: let the reply to the browser finish. A forced stop dropped it, so the
      // browser showed "connection refused" instead of the reason.
      server.stop();
    },
  };
}

async function exchange(
  options: LoginOptions,
  code: string,
  redirectUri: string,
  verifier: string,
) {
  const res = await (options.fetch ?? fetch)(`${options.hosts.auth}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": `fanvue-cli/${VERSION}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: options.clientId,
      code_verifier: verifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new CliError(
      `Login failed while exchanging the code (${res.status}: ${String(body.error ?? "no token")}).`,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: (options.now ?? Date.now)() + Number(body.expires_in) * 1000,
    scope: String(body.scope ?? ""),
  } satisfies TokenSet;
}

async function accountOf(options: LoginOptions, accessToken: string) {
  const res = await (options.fetch ?? fetch)(`${options.hosts.api}/v1/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok)
    throw new CliError(`Login succeeded but reading your account failed (${res.status}).`);
  return (await res.json()) as { handle?: string; roles?: string[] };
}

/**
 * Loopback login: authorisation code with PKCE, a consent screen every time, and the code
 * delivered only to a listener on this machine. Stores nothing for fan-only accounts.
 */
export async function login(options: LoginOptions): Promise<{ handle: string; scope: string }> {
  const pkce = await createPkce();
  const callback = listen(pkce.state, options.timeoutMs ?? 300_000);
  try {
    const authorize = new URL(`${options.hosts.auth}/oauth2/auth`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: options.clientId,
      redirect_uri: callback.url,
      scope: scopesFor(options.write).join(" "),
      resource: options.hosts.api,
      state: pkce.state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      // Our own CLI always asks; the server-side rule is what stops an impersonator.
      prompt: "consent",
    })) {
      authorize.searchParams.set(k, v);
    }

    options.print(
      "Opening your browser to sign in to Fanvue. Approve only if you ran `fanvue login` yourself.",
    );
    const opened = await options.openBrowser(authorize.toString());
    options.print(
      `${opened ? "If the browser didn't open, use" : "Open"} this link in the same session:\n${authorize}`,
    );
    const minutes = Math.round((options.timeoutMs ?? 300_000) / 60_000);
    // Fanvue sends the browser back here, so the sign-in only works while this command runs.
    options.print(
      `Waiting for Fanvue to send you back to ${callback.url} (up to ${minutes} min). Keep this running.`,
    );

    const code = await callback.code;
    const tokens = await exchange(options, code, callback.url, pkce.verifier);
    const account = await accountOf(options, tokens.accessToken);
    if (!account.roles?.some((role) => SUPPORTED_ROLES.includes(role))) {
      throw new CliError("The Fanvue CLI is for creator and agency accounts. Nothing was saved.");
    }
    await options.store.set(options.sessionKey, { ...tokens, clientId: options.clientId });
    const handle = account.handle ?? "";
    callback.finish({ ok: true, handle, write: options.write });
    return { handle, scope: tokens.scope };
  } catch (error) {
    callback.finish({
      ok: false,
      reason: error instanceof Error ? error.message : "The sign-in failed.",
    });
    throw error;
  } finally {
    callback.stop();
  }
}
