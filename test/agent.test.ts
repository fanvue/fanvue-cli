import { describe, expect, test } from "bun:test";
import { commandSchema, manifest } from "../src/agent.ts";
import { loadCommands } from "../src/commands/registry.ts";

const commands = await loadCommands();
const spec = (words: string) => {
  const found = commands.find((c) => c.command.join(" ") === words);
  if (!found) throw new Error(`no command ${words}`);
  return found;
};

describe("commandSchema", () => {
  test("arguments, typed flags, required fields and the confirmation a call needs", () => {
    const schema = commandSchema(spec("messages send"));
    expect(schema).toMatchObject({
      command: "fanvue messages send",
      method: "POST",
      path: "/v1/chats/{userUuid}/message",
      agencyPath: "/v1/creators/{creatorUserUuid}/chats/{userUuid}/message",
      confirmation: "--yes",
      arguments: ["userUuid"],
    });
    expect(schema.flags.properties.mediaUuids).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.flags.properties.price).toMatchObject({ type: "number" });
  });

  test("required flags and the fan-facing confirmation", () => {
    const schema = commandSchema(spec("account subscription-price set"));
    expect(schema.flags.required).toEqual(["subscriptionPrice"]);
    expect(schema.confirmation).toBe("--confirm <creator handle>");
    expect(commandSchema(spec("posts list")).confirmation).toBe("none");
  });
});

describe("manifest", () => {
  const text = manifest(commands);

  test("lists every command exactly once", () => {
    const lines = text.split("\n").filter((l) => l.startsWith("- `fanvue "));
    expect(lines).toHaveLength(commands.length);
  });

  test("states the conventions a caller needs before the commands", () => {
    expect(text.indexOf("Exit codes: 0 ok, 1 error, 3 confirmation needed")).toBeLessThan(
      text.indexOf("## messages"),
    );
    expect(text).toContain(
      "- `fanvue account subscription-price set --subscriptionPrice [--forceOptIn]`",
    );
  });
});
