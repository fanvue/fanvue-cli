import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT } from "../runtime/errors.ts";
import { type Hosts, PRODUCTION } from "../runtime/hosts.ts";
import { DEFAULT_CLIENT_ID, refreshTokens } from "./oauth.ts";
import { Session } from "./session.ts";
import { keychainStore, type TokenStore } from "./tokens.ts";

/** Where a command's access token comes from. */
export interface TokenSource {
  token(): Promise<string>;
  /** Called once after a 401 with the rejected token; returns a fresh one or throws. */
  after401?(rejected: string): Promise<string>;
}

type Env = Record<string, string | undefined>;

export const profileOf = (env: Env) => env.FANVUE_PROFILE ?? "default";

export function configDir(env: Env): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "fanvue");
}

/** Keychain access fails on machines without one, such as most CI runners and containers. */
export function guardedStore(store: TokenStore): TokenStore {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        `Couldn't use the system keychain: ${(error as Error).message}`,
        EXIT.auth,
        "keychain_unavailable",
      );
    }
  };
  return {
    get: (p) => guard(() => store.get(p)),
    set: (p, t) => guard(() => store.set(p, t)),
    delete: (p) => guard(() => store.delete(p)),
  };
}

/** Production sessions use the profile name; other environments get their own entry. */
export const sessionKey = (env: Env, hosts: Hosts) =>
  hosts === PRODUCTION ? profileOf(env) : `${profileOf(env)}@${new URL(hosts.api).host}`;

export function sessionFor(
  env: Env,
  hosts: Hosts = PRODUCTION,
  store: TokenStore = keychainStore,
): Session {
  const key = sessionKey(env, hosts);
  return new Session({
    store: guardedStore(store),
    profile: key,
    lockPath: join(configDir(env), `${key}.refresh.lock`),
    refresh: (current) =>
      refreshTokens(
        {
          tokenUrl: `${hosts.auth}/oauth2/token`,
          clientId: current.clientId ?? DEFAULT_CLIENT_ID,
        },
        current.refreshToken,
      ),
  });
}

export function tokenSourceFor(env: Env, hosts: Hosts = PRODUCTION): TokenSource {
  // Development stopgap until `fanvue login` lands; see CLAUDE.md.
  const devToken = env.FANVUE_TOKEN;
  if (devToken) return { token: async () => devToken };
  const session = sessionFor(env, hosts);
  return {
    token: () => session.accessToken(),
    after401: (rejected) => session.accessTokenAfter401(rejected),
  };
}
