import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { manifest } from "../agent.ts";
import type { CommandSpec } from "../commands/types.ts";
import { CliError, EXIT, UsageError } from "../runtime/errors.ts";

export const MCP_URL = "https://mcp.fanvue.com/mcp";
export const MCP_CLIENTS = ["claude-code", "cursor", "codex"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** One local change, described before it is made so the user can approve it. */
export type SetupPlan =
  | { kind: "done"; message: string }
  | { kind: "change"; summary: string; apply: () => Promise<string> };

export interface SetupDeps {
  home: string;
  cwd: string;
  /** Runs a command; returns undefined when the program isn't installed. */
  run: (argv: string[]) => Promise<{ code: number; output: string } | undefined>;
}

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Commands and files exactly as the MCP server docs give them for each client. */
export function planMcpAdd(client: string, deps: SetupDeps): SetupPlan {
  if (client === "claude-code") {
    const argv = ["claude", "mcp", "add", "--transport", "http", "Fanvue", MCP_URL];
    return {
      kind: "change",
      summary: `Run: ${argv.join(" ")}`,
      apply: async () => {
        const result = await deps.run(argv);
        if (!result) {
          throw new CliError(
            `Claude Code isn't installed here. Install it, then run: ${argv.join(" ")}`,
          );
        }
        if (result.code !== 0)
          throw new CliError(`\`claude mcp add\` failed: ${result.output.trim()}`);
        return "Added Fanvue to Claude Code. It asks you to sign in with Fanvue on first use.";
      },
    };
  }

  if (client === "cursor") {
    const path = join(deps.home, ".cursor/mcp.json");
    const text = readIfExists(path);
    let config: { mcpServers?: Record<string, unknown> };
    try {
      config = text ? JSON.parse(text) : {};
    } catch {
      throw new CliError(
        `${path} isn't valid JSON, so it wasn't changed. Fix it and run this again.`,
      );
    }
    const current = config.mcpServers?.fanvue as { url?: string } | undefined;
    if (current?.url === MCP_URL) return { kind: "done", message: `Fanvue is already in ${path}.` };
    return {
      kind: "change",
      summary: `Add "fanvue": { "url": "${MCP_URL}" } to mcpServers in ${path}`,
      apply: async () => {
        const next = { ...config, mcpServers: { ...config.mcpServers, fanvue: { url: MCP_URL } } };
        writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
        return "Added Fanvue to Cursor. Restart Cursor; it asks you to sign in with Fanvue on first use.";
      },
    };
  }

  if (client === "codex") {
    const path = join(deps.home, ".codex/config.toml");
    const text = readIfExists(path) ?? "";
    if (/^\[mcp_servers\.fanvue\]\s*$/m.test(text)) {
      return { kind: "done", message: `Fanvue is already in ${path}.` };
    }
    const block = `[mcp_servers.fanvue]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${MCP_URL}"]\n`;
    return {
      kind: "change",
      summary: `Append to ${path}:\n${block}`,
      apply: async () => {
        const separator =
          text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
        writeFile(path, `${text}${separator}${block}`);
        return "Added Fanvue to Codex. It asks you to sign in with Fanvue on first use.";
      },
    };
  }

  const which = client ? `Unknown client "${client}". ` : "Name a client. ";
  throw new UsageError(`${which}Use one of: ${MCP_CLIENTS.join(", ")}.`);
}

/** Shows a local change, asks like any other write, then makes it. Returns the line to print. */
export async function confirmAndApply(
  plan: SetupPlan,
  {
    yes,
    interactive,
    ask,
    show,
  }: {
    yes: boolean;
    interactive: boolean;
    ask: (question: string) => Promise<string>;
    show: (text: string) => void;
  },
): Promise<string> {
  if (plan.kind === "done") return plan.message;
  show(plan.summary);
  if (!yes) {
    if (!interactive) {
      throw new CliError(
        "This changes local files, so nothing was changed.",
        EXIT.needsHuman,
        "confirmation_required",
        { hint: "Re-run with --yes, or with --interactive to be asked." },
      );
    }
    if (!/^y(es)?$/i.test((await ask("Continue? [y/N] ")).trim())) {
      throw new CliError("Cancelled.", EXIT.needsHuman, "cancelled");
    }
  }
  return plan.apply();
}

export function skillContent(commands: CommandSpec[]): string {
  return `---
name: fanvue-cli
description: Use the fanvue command-line tool to read and manage a Fanvue creator or agency account (messages, fans, vault, posts, insights, links, promotions). Use when the user asks to do something on Fanvue and \`fanvue\` is installed.
---

# Using the fanvue CLI

- Always pass \`--format json\` and read the JSON. Run \`fanvue <command> --schema\` before using a command you haven't used, to see its arguments, flags and the confirmation it needs.
- Never invent UUIDs. Look them up with a list command first.
- Never add \`--yes\` or \`--confirm <handle>\` unless the user approved that exact change in this conversation. \`--confirm\` changes something fans see or pay for.
- Exit code 7 means the command needs the user's confirmation and nothing was sent: ask them. Exit code 2 means the input was wrong: read \`error.pointer\` and \`error.hint\` and fix it. Exit code 4 means they need to run \`fanvue login\` themselves (\`--write\` for changes).
- Use \`--dry-run\` to show the user a change before making it.

${manifest(commands)}`;
}

export function planSkillsAdd(
  commands: CommandSpec[],
  project: boolean,
  deps: SetupDeps,
): SetupPlan {
  const base = project ? deps.cwd : deps.home;
  const path = join(base, ".claude/skills/fanvue-cli/SKILL.md");
  const content = skillContent(commands);
  const existing = readIfExists(path);
  if (existing === content) return { kind: "done", message: `${path} is already up to date.` };
  return {
    kind: "change",
    summary: `${existing === undefined ? "Create" : "Update"} ${path}`,
    apply: async () => {
      writeFile(path, content);
      return `Wrote the fanvue-cli skill to ${path}.`;
    },
  };
}
