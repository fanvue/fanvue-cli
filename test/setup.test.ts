import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCommands } from "../src/commands/registry.ts";
import {
  confirmAndApply,
  MCP_URL,
  planMcpAdd,
  planSkillsAdd,
  type SetupDeps,
  type SetupPlan,
} from "../src/integrations/setup.ts";
import { CliError } from "../src/runtime/errors.ts";

const commands = await loadCommands();

function deps(run: SetupDeps["run"] = async () => ({ code: 0, output: "" })): SetupDeps {
  return {
    home: mkdtempSync(join(tmpdir(), "fanvue-home-")),
    cwd: mkdtempSync(join(tmpdir(), "fanvue-cwd-")),
    run,
  };
}
const apply = async (plan: SetupPlan) => {
  if (plan.kind !== "change") throw new Error(`expected a change, got: ${plan.message}`);
  return plan.apply();
};

describe("mcp add cursor", () => {
  test("adds Fanvue and keeps the servers already there", async () => {
    const d = deps();
    const path = join(d.home, ".cursor/mcp.json");
    mkdirSync(join(d.home, ".cursor"));
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: "https://x" } }, theme: 1 }));
    await apply(planMcpAdd("cursor", d));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcpServers: { other: { url: "https://x" }, fanvue: { url: MCP_URL } },
      theme: 1,
    });
    expect(planMcpAdd("cursor", d).kind).toBe("done");
  });

  test("creates the file when there is none", async () => {
    const d = deps();
    await apply(planMcpAdd("cursor", d));
    expect(
      JSON.parse(readFileSync(join(d.home, ".cursor/mcp.json"), "utf8")).mcpServers.fanvue.url,
    ).toBe(MCP_URL);
  });

  test("never overwrites a file it can't parse", () => {
    const d = deps();
    mkdirSync(join(d.home, ".cursor"));
    writeFileSync(join(d.home, ".cursor/mcp.json"), "{ not json");
    expect(() => planMcpAdd("cursor", d)).toThrow("isn't valid JSON, so it wasn't changed");
    expect(readFileSync(join(d.home, ".cursor/mcp.json"), "utf8")).toBe("{ not json");
  });
});

describe("mcp add codex", () => {
  test("appends the documented block once", async () => {
    const d = deps();
    mkdirSync(join(d.home, ".codex"));
    writeFileSync(join(d.home, ".codex/config.toml"), 'model = "x"\n');
    await apply(planMcpAdd("codex", d));
    expect(readFileSync(join(d.home, ".codex/config.toml"), "utf8")).toBe(
      `model = "x"\n\n[mcp_servers.fanvue]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "${MCP_URL}"]\n`,
    );
    expect(planMcpAdd("codex", d).kind).toBe("done");
  });
});

describe("mcp add claude-code", () => {
  test("runs the documented command", async () => {
    const calls: string[][] = [];
    await apply(
      planMcpAdd(
        "claude-code",
        deps(async (argv) => {
          calls.push(argv);
          return { code: 0, output: "" };
        }),
      ),
    );
    expect(calls).toEqual([["claude", "mcp", "add", "--transport", "http", "Fanvue", MCP_URL]]);
  });

  test("says what to run when Claude Code isn't installed", async () => {
    await expect(
      apply(
        planMcpAdd(
          "claude-code",
          deps(async () => undefined),
        ),
      ),
    ).rejects.toThrow(`then run: claude mcp add --transport http Fanvue ${MCP_URL}`);
  });

  test("unknown clients are a usage error", () => {
    expect(() => planMcpAdd("emacs", deps())).toThrow("Use one of: claude-code, cursor, codex.");
  });
});

describe("confirmAndApply", () => {
  const base = { yes: false, interactive: false, ask: async () => "", show: () => {} };

  test("refuses without --yes when nobody is at the terminal, and writes nothing", async () => {
    const d = deps();
    const error = await confirmAndApply(planMcpAdd("cursor", d), base).catch((e: CliError) => e);
    expect(error instanceof CliError && error.code).toBe("confirmation_required");
    expect(existsSync(join(d.home, ".cursor/mcp.json"))).toBe(false);
  });

  test("asks at a terminal and only writes on yes; --yes skips the question", async () => {
    const d = deps();
    await expect(
      confirmAndApply(planMcpAdd("cursor", d), {
        ...base,
        interactive: true,
        ask: async () => "n",
      }),
    ).rejects.toThrow("Cancelled.");
    expect(existsSync(join(d.home, ".cursor/mcp.json"))).toBe(false);
    await confirmAndApply(planMcpAdd("cursor", d), { ...base, yes: true });
    expect(existsSync(join(d.home, ".cursor/mcp.json"))).toBe(true);
  });
});

describe("skills add", () => {
  test("writes the skill with its rules and every command, in home or the project", async () => {
    const d = deps();
    await apply(planSkillsAdd(commands, false, d));
    const skill = readFileSync(join(d.home, ".claude/skills/fanvue-cli/SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: fanvue-cli\n")).toBe(true);
    expect(skill).toContain("Never add `--yes` or `--confirm <handle>` unless the user approved");
    expect(skill.split("\n").filter((l) => l.startsWith("- `fanvue "))).toHaveLength(
      commands.length,
    );
    expect(planSkillsAdd(commands, false, d).kind).toBe("done");

    await apply(planSkillsAdd(commands, true, d));
    expect(existsSync(join(d.cwd, ".claude/skills/fanvue-cli/SKILL.md"))).toBe(true);
  });
});
