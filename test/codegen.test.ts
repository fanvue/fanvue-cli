import { describe, expect, test } from "bun:test";
import {
  deriveCommands,
  isExcluded,
  listOperations,
  normalisePath,
} from "../src/codegen/derive.ts";
import { FAN_FACING, OVERRIDES, READ_ONLY_POSTS } from "../src/codegen/taxonomy.ts";
import { publicCommands } from "../src/commands/public.gen.ts";

const spec = (name: string) => Bun.file(new URL(`../spec/${name}`, import.meta.url)).json();
const docs = [await spec("v1.json"), await spec("v0.json")];
const derived = deriveCommands(docs);

const specKeys = new Set(
  docs
    .flatMap(listOperations)
    .filter((o) => !isExcluded(o.path))
    .map((o) => `${o.method} ${normalisePath(o.path)}`),
);
const byWords = (words: string) => derived.find((c) => c.command.join(" ") === words);

describe("command tree", () => {
  test("public.gen.ts matches the spec, so nobody edited it by hand or forgot `bun run gen`", () => {
    expect(publicCommands).toEqual(derived);
  });

  test("every public API operation gets exactly one command", () => {
    const covered = new Set(derived.map((c) => `${c.method} ${normalisePath(c.path)}`));
    expect([...specKeys].filter((k) => !covered.has(k))).toEqual([]);
    expect(derived.length).toBe(specKeys.size);
  });

  test("no two commands share the same words", () => {
    const names = derived.map((c) => c.command.join(" "));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  test("experience and app-buyer routes never become commands", () => {
    const paths = derived.flatMap((c) => [c.path, c.creatorPath ?? ""]);
    expect(
      paths.filter((p) =>
        /\/experiences|\/apps\/\{appUuid\}\/(payments\/me|subscription\/)/.test(p),
      ),
    ).toEqual([]);
  });
});

describe("public spec only", () => {
  test("every command's operation is in the public spec Styx serves", () => {
    const ids = new Set(docs.flatMap(listOperations).map((o) => o.op.operationId));
    expect(publicCommands.filter((c) => !ids.has(c.operationId))).toEqual([]);
  });
});

describe("taxonomy stays in sync with the spec", () => {
  const allKeys = new Set(
    docs.flatMap(listOperations).map((o) => `${o.method} ${normalisePath(o.path)}`),
  );

  test.each([
    ["OVERRIDES", Object.keys(OVERRIDES)],
    ["FAN_FACING", [...FAN_FACING]],
    ["READ_ONLY_POSTS", [...READ_ONLY_POSTS]],
  ])("every %s entry names a real operation", (_, keys) => {
    expect(keys.filter((k) => !allKeys.has(k))).toEqual([]);
  });
});

describe("naming and gates", () => {
  test("UI-shaped names for common jobs", () => {
    expect(byWords("messages send")?.path).toBe("/v1/chats/{userUuid}/message");
    expect(byWords("fans notes set")?.method).toBe("PUT");
    expect(byWords("posts unpin")?.method).toBe("DELETE");
    expect(byWords("vault folders list")?.path).toBe("/v1/vault/folders");
  });

  test("creator twins fold into one command with a creator path", () => {
    expect(byWords("fans subscribers list")?.creatorPath).toBe(
      "/v1/creators/{creatorUserUuid}/subscribers",
    );
    expect(byWords("account subscription-price set")?.creatorPath).toBe(
      "/v1/creators/{creatorUserUuid}/subscription-price",
    );
  });

  test("path parameters become positional arguments, without the creator id", () => {
    expect(byWords("fans lists custom remove-member")?.args).toEqual(["uuid", "userUuid"]);
    expect(byWords("fans blocks add")?.args).toEqual(["userUuid"]);
  });

  test("gates: reads, writes and fan-facing writes", () => {
    expect(derived.filter((c) => c.method === "GET" && c.gate !== "read")).toEqual([]);
    expect(byWords("messages batch")?.gate).toBe("read");
    expect(byWords("posts create")?.gate).toBe("write");
    expect(byWords("account subscription-price set")?.gate).toBe("fan-facing");
    expect(byWords("messages mass send")?.gate).toBe("fan-facing");
  });
});
