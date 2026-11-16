const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const random = (size: number) => base64url(crypto.getRandomValues(new Uint8Array(size)));

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

/** A fresh PKCE verifier (43 chars), its S256 challenge, and a state value, per login. */
export async function createPkce(): Promise<Pkce> {
  const verifier = random(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)), state: random(16) };
}
