import { CliError, EXIT } from "../runtime/errors.ts";
import { VERSION } from "../version.ts";
import type { TokenSet } from "./tokens.ts";

// The CLI service's one pre-registered public client. Must match the `clientId` of the
// service's static client.
export const DEFAULT_CLIENT_ID = "fanvue-cli";

export interface OAuthClient {
  tokenUrl: string;
  clientId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The refresh token was reused, expired or revoked. Only a new login fixes it. */
export class InvalidGrantError extends Error {}

export async function refreshTokens(client: OAuthClient, refreshToken: string): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  });
  const res = await (client.fetch ?? fetch)(client.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": `fanvue-cli/${VERSION}`,
    },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.error === "invalid_grant")
      throw new InvalidGrantError(String(body.error_description ?? ""));
    const reason = String(body.error ?? "unknown error");
    if (res.status >= 500) {
      throw new CliError(
        `Fanvue couldn't refresh your session (HTTP ${res.status}: ${reason}).`,
        EXIT.unexpected,
        "server_error",
        { status: res.status, hint: "Try again shortly." },
      );
    }
    throw new CliError(`Couldn't refresh your session (${reason}).`, EXIT.auth, "auth_required", {
      status: res.status,
      hint: "Run `fanvue login`.",
    });
  }
  const now = (client.now ?? Date.now)();
  return {
    accessToken: String(body.access_token),
    // A server that doesn't rotate leaves refresh_token out; the old one stays valid.
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
    expiresAt: now + Number(body.expires_in) * 1000,
    scope: String(body.scope ?? ""),
  };
}

const logoutFailed = (detail: string) =>
  new CliError(`Fanvue couldn't end your session (${detail}).`, EXIT.unexpected, "server_error", {
    hint: "Run `fanvue logout` again. You stay logged in until it succeeds.",
  });

/**
 * Revokes the refresh token, which ends this connection and deletes the Fanvue tokens the service
 * holds for it. A 5xx means nothing was deleted and the token still works.
 */
export async function revokeRefreshToken(
  client: { revocationUrl: string; clientId: string; fetch?: typeof fetch },
  refreshToken: string,
): Promise<void> {
  let res: Response;
  try {
    res = await (client.fetch ?? fetch)(client.revocationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": `fanvue-cli/${VERSION}`,
      },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: client.clientId,
      }),
    });
  } catch (error) {
    throw logoutFailed((error as Error).message);
  }
  if (res.status >= 500) throw logoutFailed(`HTTP ${res.status}`);
}
