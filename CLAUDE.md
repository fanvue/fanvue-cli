# fanvue-cli

Bun CLI for creators over the Fanvue public API (Styx).

## Standing decisions

- **Bun everywhere**: run, test, compile, publish. Creators get compiled binaries (about 95 MB per
  platform) through npm per-platform packages, so they don't need Bun installed.
- **The public spec Styx serves is the source** (`https://api.fanvue.com/openapi`, v1 and
  unversioned). Every operation in it is public, so there is no staff-only command set.
- **The public binary only talks to production.** The `FANVUE_API_URL`, `FANVUE_AUTH_URL` and
  `FANVUE_STYX_URL` overrides work only in builds with `FANVUE_DEV=true` (local runs, tests,
  `bun run build --dev`). `bun run check:public` fails if the override code reaches the public
  binary.
- **Creators and agencies only.** No fan-account flows; experience and app-buyer routes are
  excluded in `src/codegen/taxonomy.ts`.
- **Command tree follows the creator UI**, not API paths. Naming lives in `taxonomy.ts`
  (sections, overrides). Flags are the API's field names; nested objects take JSON.
- **Non-interactive by default** (App Platform rule): the CLI never prompts.
  Reads send; writes need `--yes`; fan-facing writes (`FAN_FACING`) need `--confirm <handle>`.
  Without the flag, nothing is sent and the error names the flag. Prompts only with
  `--interactive` at a real terminal (`isInteractive` in `src/runtime/run.ts`).
- **Never print secrets**: no token-printing command, signed media and upload URLs stay hidden
  unless asked for, `--debug` redacts the `Authorization` header.
- **Login** (`src/auth/login.ts`): PKCE S256 with no client secret against the CLI service's one
  pre-registered public client `fanvue-cli`; the service holds the Fanvue tokens and
  the CLI holds only its own. **Loopback only**: no paste-code fallback, because a code shown on
  screen can be phished remotely. The service accepts
  `http://127.0.0.1:<any port>/callback` for its native client, so the CLI listens on a port the
  OS picks; `localhost` is refused. Sends `resource=<service API>` and `prompt=consent`; the
  service shows its consent page on every login anyway. Asks for
  `openid offline_access fanvue_cli:read`; `--write` adds `fanvue_cli:write`, which the service
  maps to Fanvue's `write:*` scopes. Fan-only accounts are refused before anything is stored.
  `fanvue logout` revokes the refresh token at `/oauth2/revoke`, which deletes the service's
  Fanvue tokens for this connection; on a 5xx or network failure the session stays stored so the
  user can run it again.

- **Exit codes are a contract**, shared with the App Platform builder commands (`EXIT` in
  `src/runtime/errors.ts`): 0 ok, 1 unexpected, 2 usage, 3 manifest invalid, 4 auth or scope,
  5 drift, 6 partial apply, 7 needs a human. Never reuse a number.
- **Structured errors**: every `CliError` has a stable `code` plus optional `pointer` (JSON
  Pointer into the input: `/body/x`, `/query/x`, `/flags/x`, `/args`), `value`, `hint` and
  `status`. Without a terminal they print as `{"error": {...}}`. Callers branch on `code`.
- **Blanked API errors**: some routes reach API clients as a bare code (`{"error":"BAD_REQUEST"}`).
  `ApiError` says so rather than echoing the code as if it were an explanation.
- **Every write sends an `Idempotency-Key`**, generated once per logical write so a future retry
  reuses it.
- **`FANVUE_TOKEN` is a stopgap** for development until `fanvue login` lands. Don't build on it;
  how CI and agents authenticate is still open.
- **429s retry only for reads** (honouring `Retry-After`), so a write is never sent twice.
- **Sessions** (`src/auth/`): tokens live in the OS keychain via `Bun.secrets`. Refresh runs
  under a lock file (`~/.config/fanvue/<profile>.refresh.lock`) and saves the new pair before
  using it, because refresh tokens are single-use and reusing one revokes the whole session
  after a 30 s grace window. A 401 gets one forced refresh and one retry. Tests never touch
  the real keychain: inject a store (`test/fixtures/file-store.ts`).

## Working here

- `bun run gen` after any taxonomy or spec change; never edit `*.gen.ts` by hand.
- `bun run sync-spec` pulls the latest specs from `api.fanvue.com/openapi`.
- `FANVUE_DEV` must be checked as a bare `FANVUE_DEV && …`. A `typeof` guard stops the bundler
  from dropping the override branch.
- Hosts (`src/runtime/hosts.ts`): sessions and commands go through the CLI service,
  `auth.cli.fanvue.com` for login and `cli.fanvue.com` for API calls. A dev build reads other
  stages' hosts from `FANVUE_*_URL`, kept in a git-ignored `.env.local`. A `FANVUE_TOKEN` goes
  straight to Styx.
- Sessions per environment: production uses the profile name as its keychain entry, others use
  `<profile>@<service host>`, so they never mix.
- Checks: `bun run lint`, `bun run typecheck`, `bun test`, `bun run check:public`.
