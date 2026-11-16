import { describe, expect, test } from "bun:test";
import { commandHelp, resolve } from "../src/cli.ts";
import { loadCommands } from "../src/commands/registry.ts";
import { hostsFor } from "../src/runtime/hosts.ts";

const commands = await loadCommands();

describe("resolve", () => {
  test("a full command with its positional arguments", () => {
    const match = resolve(["messages", "send", "fan-1"], commands);
    expect(match.kind).toBe("command");
    if (match.kind === "command") {
      expect(match.spec.command).toEqual(["messages", "send"]);
      expect(match.args).toEqual(["fan-1"]);
    }
  });

  test("a group lists its children", () => {
    const match = resolve(["fans", "lists"], commands);
    expect(match).toEqual({
      kind: "group",
      path: ["fans", "lists"],
      children: ["custom", "dynamic", "smart"],
    });
  });

  test("a word that is both a command and a group runs as the command", () => {
    const match = resolve(["insights", "earnings"], commands);
    expect(match.kind === "command" && match.spec.path).toBe("/v1/insights/earnings");
  });

  test("the more specific command wins", () => {
    const match = resolve(["insights", "earnings", "summary"], commands);
    expect(match.kind === "command" && match.spec.path).toBe("/v1/insights/earnings/summary");
  });

  test("unknown words", () => {
    expect(resolve(["nope"], commands).kind).toBe("unknown");
  });
});

describe("hostsFor", () => {
  test("production by default; a dev build takes the FANVUE_*_URL overrides", () => {
    expect(hostsFor({})).toEqual({
      api: "https://cli.fanvue.com",
      auth: "https://auth.cli.fanvue.com",
      styx: "https://api.fanvue.com",
    });
    // Tests run with FANVUE_DEV=true from bunfig.toml; the public binary is checked by
    // scripts/check-public.ts instead.
    expect(
      hostsFor({
        FANVUE_API_URL: "https://cli.example.test",
        FANVUE_AUTH_URL: "https://auth.cli.example.test",
        FANVUE_STYX_URL: "https://api.example.test",
      }),
    ).toEqual({
      api: "https://cli.example.test",
      auth: "https://auth.cli.example.test",
      styx: "https://api.example.test",
    });
    expect(hostsFor({ FANVUE_AUTH_URL: "https://auth.cli.example.test" }).api).toBe(
      "https://cli.fanvue.com",
    );
  });
});

describe("commandHelp", () => {
  test("offers --creator only where a creator twin exists", () => {
    const withTwin = commands.find((c) => c.command.join(" ") === "fans subscribers list");
    const without = commands.find((c) => c.command.join(" ") === "account me");
    expect(withTwin && commandHelp(withTwin)).toContain("--creator");
    expect(without && commandHelp(without)).not.toContain("--creator");
  });
});
