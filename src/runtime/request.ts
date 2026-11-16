import type { CommandSpec, Field } from "../commands/types.ts";
import { flag, GLOBAL_FLAGS } from "./argv.ts";
import { UsageError } from "./errors.ts";

export interface ApiRequest {
  method: CommandSpec["method"];
  /** Path with arguments filled in. May still hold `{creatorUserUuid}` for creator-only routes. */
  path: string;
  query: [string, string][];
  body?: Record<string, unknown>;
}

export const SELF_PLACEHOLDER = "{creatorUserUuid}";

type Where = "query" | "body";

function coerce(field: Field, values: string[], where: Where): unknown {
  const pointer = `/${where}/${field.name}`;
  const invalid = (message: string, value: string, hint: string) =>
    new UsageError(message, "invalid_type", { pointer, value, hint });
  const parse = (type: string, value: string): unknown => {
    if (type === "integer" || type === "number") {
      const n = Number(value);
      if (Number.isNaN(n)) {
        const kind = type === "integer" ? "a whole number" : "a number";
        throw invalid(`--${field.name} must be ${kind}.`, value, `Pass ${kind}, for example 10.`);
      }
      return n;
    }
    if (type === "boolean") {
      if (value !== "true" && value !== "false") {
        throw invalid(`--${field.name} must be true or false.`, value, "Pass true or false.");
      }
      return value === "true";
    }
    if (type.includes("object")) {
      try {
        return JSON.parse(value);
      } catch {
        throw invalid(
          `--${field.name} takes JSON.`,
          value,
          `For example --${field.name} '{"key":"value"}'.`,
        );
      }
    }
    return value;
  };

  if (field.type.startsWith("array of ")) {
    const item = field.type.slice("array of ".length);
    return values.map((v) => parse(item, v));
  }
  return parse(field.type, values.at(-1) as string);
}

function fillPath(spec: CommandSpec, positionals: string[], creator: string | undefined) {
  if (creator && !spec.creatorPath) {
    throw new UsageError(
      `\`fanvue ${spec.command.join(" ")}\` has no agency version, so --creator doesn't apply.`,
      "creator_not_supported",
      { pointer: "/flags/creator", value: creator },
    );
  }
  let path = creator ? (spec.creatorPath as string) : spec.path;
  if (creator) path = path.replace(SELF_PLACEHOLDER, encodeURIComponent(creator));
  spec.args.forEach((name, i) => {
    path = path.replace(`{${name}}`, encodeURIComponent(positionals[i] as string));
  });
  return path;
}

type Flags = Map<string, string[]>;

function rejectUnknownFlags(spec: CommandSpec, flags: Flags) {
  const known = new Set([...spec.query, ...(spec.body?.fields ?? [])].map((f) => f.name));
  const unknown = [...flags.keys()].find((name) => !known.has(name) && !GLOBAL_FLAGS.has(name));
  if (unknown) {
    throw new UsageError(`Unknown flag --${unknown}.`, "unknown_flag", {
      pointer: `/flags/${unknown}`,
      hint: `Run \`fanvue ${spec.command.join(" ")} --schema\` for the flags it takes.`,
    });
  }
}

const missingFlag = (name: string, where: Where) =>
  new UsageError(`--${name} is required.`, "missing_flag", { pointer: `/${where}/${name}` });

function queryFrom(fields: Field[], flags: Flags): [string, string][] {
  return fields.flatMap((field) => {
    const values = flags.get(field.name);
    if (!values) {
      if (field.required) throw missingFlag(field.name, "query");
      return [];
    }
    const value = coerce(field, values, "query");
    return (Array.isArray(value) ? value : [value]).map((v): [string, string] => [
      field.name,
      String(v),
    ]);
  });
}

/** Starts from `--data`, then lets individual flags override its fields. */
function bodyFrom(fields: Field[], flags: Flags, data: Record<string, unknown> | undefined) {
  const body: Record<string, unknown> = { ...data };
  for (const field of fields) {
    const values = flags.get(field.name);
    if (values) body[field.name] = coerce(field, values, "body");
  }
  const missing = fields.find((f) => f.required && body[f.name] === undefined);
  if (missing) throw missingFlag(missing.name, "body");
  return body;
}

/**
 * Builds the API request for a command from what the user typed. `data` is the parsed
 * `--data` value, already read from a file when given as `@file`.
 */
export function buildRequest(
  spec: CommandSpec,
  positionals: string[],
  flags: Flags,
  data?: Record<string, unknown>,
): ApiRequest {
  if (positionals.length !== spec.args.length) {
    const usage = ["fanvue", ...spec.command, ...spec.args.map((a) => `<${a}>`)].join(" ");
    throw new UsageError(`Expected ${spec.args.length} argument(s).`, "wrong_arguments", {
      pointer: "/args",
      value: positionals,
      hint: `Usage: ${usage}`,
    });
  }
  rejectUnknownFlags(spec, flags);

  const request: ApiRequest = {
    method: spec.method,
    path: fillPath(spec, positionals, flag(flags, "creator")),
    query: queryFrom(spec.query, flags),
  };
  if (spec.body) {
    const body = bodyFrom(spec.body.fields, flags, data);
    if (Object.keys(body).length || spec.body.required) request.body = body;
  }
  return request;
}
