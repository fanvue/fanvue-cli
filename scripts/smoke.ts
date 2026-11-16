// End-to-end smoke test against the real API with whatever session you have (`fanvue login`, or
// FANVUE_TOKEN while the OAuth client is pending). Read-only: nothing on the account changes.
//   bun run smoke                 production
//   FANVUE_API_URL=… FANVUE_AUTH_URL=… FANVUE_STYX_URL=… bun run smoke   another stage
//   bun run smoke --creator <id>  also run the agency path for a creator you manage
import { flag, parseArgv } from "../src/runtime/argv.ts";
import { EXIT } from "../src/runtime/errors.ts";

const { flags } = parseArgv(Bun.argv.slice(2));
const creator = flag(flags, "creator");
const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

interface Result {
  code: number;
  json: unknown;
  stderr: string;
}

async function fanvue(...args: string[]): Promise<Result> {
  const proc = Bun.spawn(["bun", "run", ENTRY, ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const parse = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return text.trim();
    }
  };
  return { code, json: parse(out), stderr: err.trim() };
}

type Check = { name: string; run: () => Promise<string | undefined> };
const get = (value: unknown, key: string) => (value as Record<string, unknown> | null)?.[key];
const fail = (r: Result) => `exit ${r.code}: ${r.stderr || JSON.stringify(r.json).slice(0, 200)}`;

const checks: Check[] = [
  {
    name: "account me returns your profile",
    run: async () => {
      const r = await fanvue("account", "me");
      if (r.code !== 0) return fail(r);
      return get(r.json, "uuid") && get(r.json, "handle") ? undefined : "no uuid or handle";
    },
  },
  {
    name: "posts list pages with a cursor",
    run: async () => {
      const first = await fanvue("posts", "list", "--size", "1");
      if (first.code !== 0) return fail(first);
      const cursor = get(first.json, "nextCursor");
      if (typeof cursor !== "string") return undefined; // one page or fewer: nothing to follow
      const second = await fanvue("posts", "list", "--size", "1", "--cursor", cursor);
      return second.code === 0 ? undefined : fail(second);
    },
  },
  {
    name: "fans subscribers list",
    run: async () => {
      const r = await fanvue("fans", "subscribers", "list", "--size", "1");
      return r.code === 0 ? undefined : fail(r);
    },
  },
  {
    name: "insights earnings summary",
    run: async () => {
      const r = await fanvue("insights", "earnings", "summary");
      return r.code === 0 ? undefined : fail(r);
    },
  },
  {
    name: "messages unread",
    run: async () => {
      const r = await fanvue("messages", "unread");
      return r.code === 0 ? undefined : fail(r);
    },
  },
  {
    name: "a write without --yes sends nothing and exits 7",
    run: async () => {
      const r = await fanvue("posts", "delete", "00000000-0000-4000-8000-000000000000");
      return r.code === EXIT.needsHuman ? undefined : `expected exit 7, ${fail(r)}`;
    },
  },
  {
    name: "a fan-facing write with only --yes is refused (exit 7)",
    run: async () => {
      const r = await fanvue(
        "account",
        "subscription-price",
        "set",
        "--subscriptionPrice",
        "999",
        "--yes",
      );
      return r.code === EXIT.needsHuman ? undefined : `expected exit 7, ${fail(r)}`;
    },
  },
  {
    name: "--dry-run prints a write without sending it",
    run: async () => {
      const r = await fanvue(
        "posts",
        "create",
        "--text",
        "smoke",
        "--audience",
        "subscribers",
        "--dry-run",
      );
      return r.code === 0 && String(r.json).startsWith("POST ") ? undefined : fail(r);
    },
  },
  {
    name: "bad input exits 2 with a pointer",
    run: async () => {
      const r = await fanvue("posts", "list", "--size", "ten");
      const pointer = get(get(JSON.parse(r.stderr || "{}"), "error"), "pointer");
      return r.code === EXIT.usage && pointer === "/query/size" ? undefined : fail(r);
    },
  },
];

if (creator) {
  checks.push({
    name: `agency path: fans subscribers list --creator ${creator}`,
    run: async () => {
      const r = await fanvue("fans", "subscribers", "list", "--size", "1", "--creator", creator);
      return r.code === 0 ? undefined : fail(r);
    },
  });
}

const auth = await fanvue("account", "me");
if (auth.code === EXIT.auth) {
  console.error("Not logged in. Run `fanvue login`, or set FANVUE_TOKEN, then run this again.");
  process.exit(EXIT.auth);
}

let failed = 0;
for (const check of checks) {
  const problem = await check.run();
  if (problem) failed += 1;
  console.log(`${problem ? "✗" : "✓"} ${check.name}${problem ? `\n    ${problem}` : ""}`);
}
console.log(`\n${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? EXIT.unexpected : EXIT.ok);
