import type { CommandSpec, Field } from "./commands/types.ts";
import { VERSION } from "./version.ts";

type JsonSchema = Record<string, unknown>;

function schemaOf(type: string): JsonSchema {
  if (type.startsWith("array of ")) return { type: "array", items: schemaOf(type.slice(9)) };
  if (["string", "integer", "number", "boolean", "object"].includes(type)) return { type };
  return {};
}

const property = (field: Field): JsonSchema => ({
  ...schemaOf(field.type),
  ...(field.description ? { description: field.description } : {}),
});

const CONFIRMATION = {
  read: "none",
  write: "--yes",
  "fan-facing": "--confirm <creator handle>",
} as const;

/** One command's contract, for tools that build calls programmatically (`--schema`). */
export function commandSchema(spec: CommandSpec) {
  const fields = [...spec.query, ...(spec.body?.fields ?? [])];
  return {
    command: ["fanvue", ...spec.command].join(" "),
    summary: spec.summary,
    method: spec.method,
    path: spec.path,
    ...(spec.creatorPath ? { agencyPath: spec.creatorPath } : {}),
    confirmation: CONFIRMATION[spec.gate],
    scopes: spec.scopes,
    arguments: spec.args,
    flags: {
      type: "object",
      properties: Object.fromEntries(fields.map((f) => [f.name, property(f)])),
      required: fields.filter((f) => f.required).map((f) => f.name),
    },
  };
}

function usageLine(spec: CommandSpec): string {
  const args = spec.args.map((a) => `<${a}>`);
  const flags = [...spec.query, ...(spec.body?.fields ?? [])].map((f) =>
    f.required ? `--${f.name}` : `[--${f.name}]`,
  );
  const notes = [
    spec.gate === "read" ? "" : `confirm: ${CONFIRMATION[spec.gate]}`,
    spec.creatorPath ? "agency: --creator" : "",
  ].filter(Boolean);
  const tail = notes.length ? ` (${notes.join("; ")})` : "";
  return `- \`${["fanvue", ...spec.command, ...args, ...flags].join(" ")}\`: ${spec.summary}${tail}`;
}

/** The whole CLI as one compact text, for tools that read it in one go (`--llms`). */
export function manifest(commands: CommandSpec[]): string {
  const groups = [...new Set(commands.map((c) => c.command[0] as string))];
  const sections = groups.map((group) => {
    const lines = commands.filter((c) => c.command[0] === group).map(usageLine);
    return `## ${group}\n\n${lines.join("\n")}`;
  });
  return `# fanvue ${VERSION}

Fanvue from the terminal: one command per Fanvue public API operation, for creators and agencies.

## Conventions

- Flags are the API's field names. Repeat a flag for a list; pass objects as JSON; \`--data @file.json\` sends a whole body and flags override its fields.
- \`--format json\` (the default when piped) or \`jsonl\` for machine output. \`--all\` follows pagination.
- Media flags (\`mediaUuids\`, \`mediaPreviewUuid\`) also take a file path, which uploads first.
- Never prompts. Writes need \`--yes\`. Changes fans see or pay for need \`--confirm <creator handle>\`; \`--yes\` alone is refused. \`--interactive\` at a terminal asks instead.
- \`--dry-run\` prints the request without sending. \`--schema\` prints a command's input as JSON Schema. \`--json\` is short for \`--format json\`.
- Exit codes: 0 ok, 1 unexpected, 2 usage, 4 login or scope, 7 needs a human (nothing sent); 3, 5 and 6 are reserved. Errors print as JSON \`{"error":{"code","message","pointer","value","hint","status"}}\`.

${sections.join("\n\n")}
`;
}
