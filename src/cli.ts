import type { CommandSpec, Field } from "./commands/types.ts";
import { VERSION } from "./version.ts";

const GROUPS: Record<string, string> = {
  messages: "Chats, mass messages, templates and automated messages",
  fans: "Subscribers, followers, lists, notes and fan insights",
  vault: "Media, folders, collections and uploads",
  posts: "Posts, comments, likes and tips",
  insights: "Earnings, spending, retention and top spenders",
  links: "Tracking, checkout, free-trial and media links",
  promotions: "Subscription discounts and free trials",
  account: "Your profile, account health, notifications and price",
  agency: "Team, creators and agency-wide insights (agency accounts)",
  webhooks: "Webhook subscriptions",
  apps: "Your App Store apps",
};

export type Resolution =
  | { kind: "command"; spec: CommandSpec; args: string[] }
  | { kind: "group"; path: string[]; children: string[] }
  | { kind: "unknown"; path: string[] };

/** Matches the words a user typed against the command tree. */
export function resolve(words: string[], commands: CommandSpec[]): Resolution {
  let best: CommandSpec | undefined;
  for (const spec of commands) {
    const matches = spec.command.every((w, i) => words[i] === w);
    if (matches && spec.command.length > (best?.command.length ?? 0)) best = spec;
  }
  const deeper = commands.filter((c) => words.every((w, i) => c.command[i] === w));
  const exactLeaf = best && best.command.length === words.length;

  // A word that is also a group (e.g. `insights earnings`) runs as a command only when
  // nothing more specific was typed.
  if (best && (exactLeaf || deeper.length === 0)) {
    return { kind: "command", spec: best, args: words.slice(best.command.length) };
  }
  if (deeper.length > 0) {
    const children = [...new Set(deeper.map((c) => c.command[words.length]).filter(Boolean))];
    return { kind: "group", path: words, children: children as string[] };
  }
  return { kind: "unknown", path: words };
}

export function rootHelp(): string {
  const width = Math.max(...Object.keys(GROUPS).map((g) => g.length));
  const groups = Object.entries(GROUPS)
    .map(([name, about]) => `  ${name.padEnd(width)}  ${about}`)
    .join("\n");
  return `fanvue ${VERSION}: Fanvue from your terminal

Usage: fanvue <group> <command> [args] [flags]

Groups:
${groups}

Session:
  login       Sign in through your browser (read access; add --write to make changes)
  logout      Forget the session stored in your keychain

Setup:
  mcp add <claude-code|cursor|codex>   Connect that client to the Fanvue MCP server
  skills add [--project]                Teach your coding tool to use this CLI

Flags:
  -h, --help     Show help for any group or command
  --schema       Print a command's input as JSON Schema
  --llms         Print every command in one compact manifest
  -v, --version  Print the version

Run \`fanvue <group>\` to see its commands.`;
}

export function groupHelp(path: string[], children: string[], commands: CommandSpec[]): string {
  const lines = children.sort().map((child) => {
    const full = [...path, child];
    const leaf = commands.find((c) => c.command.join(" ") === full.join(" "));
    const count = commands.filter((c) => full.every((w, i) => c.command[i] === w)).length;
    return `  ${child.padEnd(24)}${leaf?.summary ?? `${count} commands`}`;
  });
  return `Usage: fanvue ${path.join(" ")} <command>\n\nCommands:\n${lines.join("\n")}`;
}

function flagLine(field: Field) {
  const flag = `--${field.name}`;
  const json = field.type.includes("object") ? " (JSON)" : "";
  return `  ${flag.padEnd(28)}${field.type}${json}${field.required ? ", required" : ""}`;
}

export function commandHelp(spec: CommandSpec): string {
  const usage = ["fanvue", ...spec.command, ...spec.args.map((a) => `<${a}>`)].join(" ");
  const sections = [`${spec.summary}\n\nUsage: ${usage} [flags]`];
  if (spec.query.length) sections.push(`Query flags:\n${spec.query.map(flagLine).join("\n")}`);
  if (spec.body?.fields.length) {
    sections.push(
      `Body flags (or --data @file.json):\n${spec.body.fields.map(flagLine).join("\n")}`,
    );
  }
  if (spec.creatorPath) sections.push("Agencies: add --creator <uuid> to act for a creator.");
  const gate = {
    read: "Reads only.",
    write: "Changes data: pass --yes, or --interactive to be asked.",
    "fan-facing":
      "Fans see this change: pass --confirm <creator handle>, or --interactive to type it.",
  }[spec.gate];
  sections.push(`${gate} Sends ${spec.method} ${spec.path}.`);
  return sections.join("\n\n");
}
