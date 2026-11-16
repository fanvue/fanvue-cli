import { CliError, EXIT } from "../runtime/errors.ts";
import { withLock } from "./lock.ts";
import { InvalidGrantError } from "./oauth.ts";
import type { TokenSet, TokenStore } from "./tokens.ts";

/** Refresh this long before expiry, as the API docs recommend. */
const REFRESH_BUFFER_MS = 5 * 60_000;

export interface SessionOptions {
  store: TokenStore;
  profile: string;
  lockPath: string;
  refresh: (current: TokenSet) => Promise<TokenSet>;
  now?: () => number;
}

const notLoggedIn = () =>
  new CliError("Not logged in. Run `fanvue login`.", EXIT.auth, "auth_required");

const sessionEnded = () =>
  new CliError(
    "Your Fanvue session ended (expired or revoked). Run `fanvue login`.",
    EXIT.auth,
    "auth_required",
  );

export class Session {
  constructor(private readonly options: SessionOptions) {}

  private fresh(tokens: TokenSet) {
    const now = (this.options.now ?? Date.now)();
    return tokens.expiresAt - now > REFRESH_BUFFER_MS;
  }

  /** A usable access token, refreshing first when it is about to expire. */
  async accessToken(): Promise<string> {
    const current = await this.options.store.get(this.options.profile);
    if (!current) throw notLoggedIn();
    if (this.fresh(current)) return current.accessToken;
    return this.refreshFrom(current, false);
  }

  /** After a 401: refresh even if the token looks valid, unless another process just did. */
  async accessTokenAfter401(rejected: string): Promise<string> {
    const current = await this.options.store.get(this.options.profile);
    if (!current) throw notLoggedIn();
    if (current.accessToken !== rejected) return current.accessToken;
    return this.refreshFrom(current, true);
  }

  private refreshFrom(seen: TokenSet, force: boolean): Promise<string> {
    const { store, profile, lockPath, refresh } = this.options;
    return withLock(lockPath, async () => {
      // Another process may have refreshed while this one waited for the lock.
      const latest = await store.get(profile);
      if (!latest) throw notLoggedIn();
      if (latest.refreshToken !== seen.refreshToken || (!force && this.fresh(latest))) {
        return latest.accessToken;
      }

      let next: TokenSet;
      try {
        next = await refresh(latest);
        if (latest.clientId) next = { ...next, clientId: latest.clientId };
      } catch (error) {
        if (error instanceof InvalidGrantError) {
          await store.delete(profile);
          throw sessionEnded();
        }
        throw error;
      }
      // Persist before anything else: the old refresh token is now spent, and this response
      // is the only copy of its replacement.
      await store.set(profile, next);
      return next.accessToken;
    });
  }
}
