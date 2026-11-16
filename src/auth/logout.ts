import type { TokenSet, TokenStore } from "./tokens.ts";

/**
 * Ends the session at the service, then forgets it. When the service can't end it, the session
 * stays stored so `fanvue logout` can be run again. Returns false when there was none.
 */
export async function logout(
  store: TokenStore,
  profile: string,
  revoke: (tokens: TokenSet) => Promise<void>,
): Promise<boolean> {
  const existing = await store.get(profile);
  if (!existing) return false;
  await revoke(existing);
  await store.delete(profile);
  return true;
}
