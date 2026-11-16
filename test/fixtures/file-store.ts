import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { TokenSet, TokenStore } from "../../src/auth/tokens.ts";

/** A token store several test processes can share. Tests only: tokens on disk in plain text. */
export function fileStore(path: string): TokenStore {
  const read = (): Record<string, TokenSet> => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  };
  return {
    async get(profile) {
      return read()[profile];
    },
    async set(profile, tokens) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...read(), [profile]: tokens }));
      renameSync(tmp, path);
    },
    async delete(profile) {
      const all = read();
      delete all[profile];
      if (Object.keys(all).length) writeFileSync(path, JSON.stringify(all));
      else rmSync(path, { force: true });
    },
  };
}

export function memoryStore(initial?: TokenSet): TokenStore & { value: TokenSet | undefined } {
  const store = {
    value: initial,
    async get() {
      return store.value;
    },
    async set(_profile: string, tokens: TokenSet) {
      store.value = tokens;
    },
    async delete() {
      store.value = undefined;
    },
  };
  return store;
}
