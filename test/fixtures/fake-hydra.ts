/**
 * A token endpoint that rotates refresh tokens the way Ory Hydra does: each refresh
 * token works once, a spent one is still accepted inside the grace window, and a spent one
 * presented after it revokes every token in the session.
 */
export interface FakeHydraOptions {
  graceMs?: number;
  /** Delay before answering a refresh, to make concurrent requests overlap. */
  delayMs?: number;
  now?: () => number;
}

export function startFakeHydra({
  graceMs = 0,
  delayMs = 0,
  now = Date.now,
}: FakeHydraOptions = {}) {
  let counter = 0;
  const live = new Set<string>(["r0"]);
  const spentAt = new Map<string, number>();
  const state = { refreshes: 0, revoked: false };

  const issue = () => {
    counter += 1;
    const refreshToken = `r${counter}`;
    live.add(refreshToken);
    return {
      access_token: `a${counter}`,
      refresh_token: refreshToken,
      expires_in: 3600,
      scope: "read:self",
    };
  };
  const invalidGrant = () => Response.json({ error: "invalid_grant" }, { status: 400 });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = new URLSearchParams(await req.text());
      const token = form.get("refresh_token") ?? "";
      state.refreshes += 1;
      if (delayMs) await Bun.sleep(delayMs);
      if (state.revoked) return invalidGrant();
      if (live.delete(token)) {
        spentAt.set(token, now());
        return Response.json(issue());
      }
      const spent = spentAt.get(token);
      if (spent !== undefined && graceMs > 0 && now() - spent <= graceMs) {
        return Response.json(issue());
      }
      state.revoked = true;
      return invalidGrant();
    },
  });
  return { url: `${server.url}oauth2/token`, state, stop: () => server.stop(true) };
}
