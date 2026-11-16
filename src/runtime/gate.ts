import type { Gate } from "../commands/types.ts";

export type GateDecision =
  | { kind: "send" }
  | { kind: "ask-yes" }
  | { kind: "ask-handle" }
  | { kind: "check-handle"; handle: string }
  | { kind: "refuse"; message: string; hint: string };

interface GateInput {
  gate: Gate;
  yes: boolean;
  /** Value of `--confirm`, the non-interactive acknowledgement for fan-facing writes. */
  confirm: string | undefined;
  /** True only with `--interactive` at a terminal. The CLI never prompts otherwise. */
  interactive: boolean;
}

/**
 * Decides what has to happen before a request is sent. Non-interactive by default: a change
 * that needs acknowledgement fails and names the flag that would authorise it, so an agent
 * never hangs on a prompt. Nothing here does I/O, so every combination is unit-tested.
 */
export function decideGate({ gate, yes, confirm, interactive }: GateInput): GateDecision {
  if (gate === "read") return { kind: "send" };
  if (gate === "write") {
    if (yes) return { kind: "send" };
    if (interactive) return { kind: "ask-yes" };
    return {
      kind: "refuse",
      message: "This changes data, so nothing was sent.",
      hint: "Re-run with --yes, or with --interactive to be asked.",
    };
  }
  // Fan-facing: --yes alone is never enough, because an agent can add it without thinking.
  if (confirm !== undefined) return { kind: "check-handle", handle: confirm };
  if (interactive) return { kind: "ask-handle" };
  return {
    kind: "refuse",
    message: "Fans see this change, so nothing was sent.",
    hint: "Re-run with --confirm <creator handle>, or with --interactive to type it.",
  };
}

export const sameHandle = (typed: string, actual: string) =>
  typed.trim().replace(/^@/, "").toLowerCase() === actual.replace(/^@/, "").toLowerCase();
