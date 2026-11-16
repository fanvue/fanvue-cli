import { UsageError } from "./errors.ts";

/** Flags that take no value. Everything else reads the next word, or `--name=value`. */
const SWITCHES = new Set([
  "help",
  "h",
  "version",
  "v",
  "yes",
  "y",
  "dry-run",
  "all",
  "debug",
  "show-url",
  "schema",
  "llms",
  "write",
  "project",
  "json",
  "interactive",
]);

/** Flags every command accepts, on top of its own query and body fields. */
export const GLOBAL_FLAGS = new Set([...SWITCHES, "creator", "format", "data", "confirm", "env"]);

export interface ParsedArgv {
  words: string[];
  flags: Map<string, string[]>;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-" || /^-\d/.test(arg)) {
      words.push(arg);
      continue;
    }
    const raw = arg.replace(/^--?/, "");
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    let value: string;
    if (eq >= 0) value = raw.slice(eq + 1);
    else if (SWITCHES.has(name)) value = "true";
    else {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new UsageError(`--${name} needs a value.`, "missing_value", {
          pointer: `/flags/${name}`,
        });
      }
      value = next;
      i++;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { words, flags };
}

export const flag = (flags: Map<string, string[]>, name: string) => flags.get(name)?.at(-1);
export const has = (flags: Map<string, string[]>, ...names: string[]) =>
  names.some((n) => flags.get(n)?.at(-1) === "true");
