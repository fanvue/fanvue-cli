/**
 * `api` and `auth` are the CLI service, which holds the Fanvue tokens and forwards to
 * Styx. `styx` is Fanvue's API itself, reached only with a `FANVUE_TOKEN`.
 */
export interface Hosts {
  api: string;
  auth: string;
  styx: string;
}

export const PRODUCTION: Hosts = {
  api: "https://cli.fanvue.com",
  auth: "https://auth.cli.fanvue.com",
  styx: "https://api.fanvue.com",
};

// Always defined: bunfig.toml for local runs and tests, `--define` in scripts/build.ts. Keep it a
// bare `FANVUE_DEV &&` check: the bundler only drops the override branch from the public binary
// when the condition folds to false, and a `typeof` guard stops that.
declare const FANVUE_DEV: boolean;

/**
 * The hosts the CLI talks to. Development builds take `FANVUE_API_URL`, `FANVUE_AUTH_URL` and
 * `FANVUE_STYX_URL` to point at another stage; the public binary always uses {@link PRODUCTION}.
 */
export function hostsFor(env: Readonly<Record<string, string | undefined>>): Hosts {
  return (
    (FANVUE_DEV && {
      api: env.FANVUE_API_URL ?? PRODUCTION.api,
      auth: env.FANVUE_AUTH_URL ?? PRODUCTION.auth,
      styx: env.FANVUE_STYX_URL ?? PRODUCTION.styx,
    }) ||
    PRODUCTION
  );
}
