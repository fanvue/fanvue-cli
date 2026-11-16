import { handwrittenCommands } from "./handwritten.ts";
import { publicCommands } from "./public.gen.ts";
import type { CommandSpec } from "./types.ts";

export async function loadCommands(): Promise<CommandSpec[]> {
  return [...publicCommands, ...handwrittenCommands].sort((a, b) =>
    a.command.join(" ").localeCompare(b.command.join(" ")),
  );
}
