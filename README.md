# fanvue

Fanvue from your terminal: messages, fans, vault, posts, insights and links, for creators and
agencies.

Status: early. Every public API operation is a command, and requests work end to end. `fanvue
login` signs in through the CLI service at `auth.cli.fanvue.com`, which isn't deployed yet, so for
development use a token from your own Developer Area app (it goes straight to `api.fanvue.com`):

```sh
bun install
bun run dev --help
bun run dev messages send <fan uuid> --text "hi" --dry-run   # prints the request, sends nothing
FANVUE_TOKEN=… bun run dev posts list --format json
```

- Never prompts by default. Writes need `--yes`; writes fans see or pay for need
  `--confirm <your handle>`. Add `--interactive` to be asked instead.
- `--format table|json|jsonl` (or `--json`), `--all` to follow pages, `--creator <uuid>` for
  agencies.
- Exit codes: 0 ok, 1 unexpected, 2 usage, 4 login or scope, 7 needs a human. Errors without a
  terminal print as JSON with a stable `code`, a `pointer` to the bad input and a `hint`.
- `fanvue api GET /v1/...` sends a raw request to any route the CLI has a command for.

The full command list is in [`docs/commands.txt`](docs/commands.txt).
