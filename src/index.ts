#!/usr/bin/env bun
import { homedir } from "node:os";
import { commandSchema, manifest } from "./agent.ts";
import { openBrowser, SSH_HINT } from "./auth/browser.ts";
import { login } from "./auth/login.ts";
import { logout } from "./auth/logout.ts";
import { DEFAULT_CLIENT_ID, revokeRefreshToken } from "./auth/oauth.ts";
import { guardedStore, sessionKey } from "./auth/source.ts";
import { keychainStore } from "./auth/tokens.ts";
import { commandHelp, groupHelp, resolve, rootHelp } from "./cli.ts";
import { loadCommands } from "./commands/registry.ts";
import {
  confirmAndApply,
  planMcpAdd,
  planSkillsAdd,
  type SetupDeps,
  type SetupPlan,
} from "./integrations/setup.ts";
import { has, parseArgv } from "./runtime/argv.ts";
import { CliError, EXIT, errorJson, UsageError } from "./runtime/errors.ts";
import { hostsFor } from "./runtime/hosts.ts";
import { formatOf, type Io, isInteractive, runCommand, runRaw } from "./runtime/run.ts";
import { VERSION } from "./version.ts";

const io: Io = {
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  terminalOutput: Boolean(process.stdout.isTTY),
  ask: async (question) => prompt(question) ?? "",
  readFile: (path) => Bun.file(path).text(),
  openFile: async (path) => {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    return {
      size: file.size,
      read: async (start, length) =>
        new Uint8Array(await file.slice(start, start + length).arrayBuffer()),
    };
  },
  env: process.env,
};

async function runLogin(flags: Map<string, string[]>): Promise<number> {
  const hosts = hostsFor(io.env);
  const write = has(flags, "write");
  const result = await login({
    hosts,
    clientId: DEFAULT_CLIENT_ID,
    write,
    store: guardedStore(keychainStore),
    sessionKey: sessionKey(io.env, hosts),
    openBrowser: async (url) => {
      const opened = await openBrowser(url);
      if (!opened && (io.env.SSH_CONNECTION || io.env.SSH_TTY)) io.stderr(SSH_HINT);
      return opened;
    },
    print: io.stderr,
  });
  io.stdout(
    write
      ? `Logged in as @${result.handle} with read and write access.`
      : `Logged in as @${result.handle} with read access. Run \`fanvue login --write\` to make changes.`,
  );
  return EXIT.ok;
}

const setupDeps = (): SetupDeps => ({
  home: io.env.HOME ?? homedir(),
  cwd: process.cwd(),
  run: async (argv) => {
    try {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const output =
        (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      return { code: await proc.exited, output };
    } catch {
      return undefined;
    }
  },
});

async function runSetup(plan: SetupPlan, flags: Map<string, string[]>): Promise<number> {
  const options = {
    yes: has(flags, "yes", "y"),
    interactive: isInteractive(flags, io),
    ask: io.ask,
    show: io.stderr,
  };
  io.stdout(await confirmAndApply(plan, options));
  return EXIT.ok;
}

/** Session and setup commands, which aren't API operations. Undefined when `words` isn't one. */
async function runLocalCommand(
  words: string[],
  flags: Map<string, string[]>,
): Promise<number | undefined> {
  const line = words.join(" ");
  if (line === "login") return runLogin(flags);
  if (words[0] === "mcp" && words[1] === "add" && words.length <= 3) {
    return runSetup(planMcpAdd(words[2] ?? "", setupDeps()), flags);
  }
  if (line === "skills add") {
    return runSetup(planSkillsAdd(await loadCommands(), has(flags, "project"), setupDeps()), flags);
  }
  if (line === "logout") {
    const hosts = hostsFor(io.env);
    const key = sessionKey(io.env, hosts);
    const removed = await logout(keychainStore, key, (tokens) =>
      revokeRefreshToken(
        {
          revocationUrl: `${hosts.auth}/oauth2/revoke`,
          clientId: tokens.clientId ?? DEFAULT_CLIENT_ID,
        },
        tokens.refreshToken,
      ),
    );
    io.stdout(removed ? `Logged out (${key}).` : `Not logged in (${key}).`);
    return EXIT.ok;
  }
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  const { words, flags } = parseArgv(argv);
  if (has(flags, "version", "v")) {
    io.stdout(VERSION);
    return EXIT.ok;
  }
  if (has(flags, "llms")) {
    io.stdout(manifest(await loadCommands()));
    return EXIT.ok;
  }
  if (words.length === 0) {
    io.stdout(rootHelp());
    return EXIT.ok;
  }

  const local = await runLocalCommand(words, flags);
  if (local !== undefined) return local;

  const commands = await loadCommands();
  if (words[0] === "api") return runRaw(words.slice(1), flags, commands, io);

  const match = resolve(words, commands);
  if (match.kind === "unknown") {
    throw new UsageError(`Unknown command: fanvue ${match.path.join(" ")}.`, "unknown_command", {
      value: match.path.join(" "),
      hint: "Run `fanvue --help`, or `fanvue --llms` for every command.",
    });
  }
  if (match.kind === "group") {
    io.stdout(groupHelp(match.path, match.children, commands));
    return EXIT.ok;
  }
  if (has(flags, "help", "h")) {
    io.stdout(commandHelp(match.spec));
    return EXIT.ok;
  }
  if (has(flags, "schema")) {
    io.stdout(JSON.stringify(commandSchema(match.spec), null, 2));
    return EXIT.ok;
  }
  return runCommand(match.spec, match.args, flags, io);
}

try {
  process.exit(await main(Bun.argv.slice(2)));
} catch (error) {
  if (!(error instanceof CliError)) throw error;
  // Scripts and agents get a parseable error; people get the sentence.
  const wantsJson = (() => {
    try {
      return (
        formatOf(parseArgv(Bun.argv.slice(2)).flags, Boolean(process.stderr.isTTY)) !== "table"
      );
    } catch {
      return false;
    }
  })();
  const { hint } = error.detail;
  io.stderr(
    wantsJson ? JSON.stringify(errorJson(error)) : [error.message, hint].filter(Boolean).join("\n"),
  );
  process.exit(error.exitCode);
}
