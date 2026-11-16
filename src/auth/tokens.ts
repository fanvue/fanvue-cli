export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  scope: string;
  /** The OAuth client that issued the session; refresh must use the same one. */
  clientId?: string;
}

export interface TokenStore {
  get(profile: string): Promise<TokenSet | undefined>;
  set(profile: string, tokens: TokenSet): Promise<void>;
  delete(profile: string): Promise<void>;
}

const SERVICE = "fanvue-cli";

/** The OS keychain (macOS Keychain, libsecret, Windows Credential Manager) via Bun.secrets. */
export const keychainStore: TokenStore = {
  async get(profile) {
    const value = await Bun.secrets.get({ service: SERVICE, name: profile });
    return value ? (JSON.parse(value) as TokenSet) : undefined;
  },
  async set(profile, tokens) {
    await Bun.secrets.set({ service: SERVICE, name: profile, value: JSON.stringify(tokens) });
  },
  async delete(profile) {
    await Bun.secrets.delete({ service: SERVICE, name: profile });
  },
};
