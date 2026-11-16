// Turns the compiled binaries in dist/public into the npm packages: one per platform holding its
// binary, and @fanvue/cli, a small launcher that lists them as optionalDependencies so npm only
// downloads the one that matches the machine.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist/npm");

// Bun target suffix → npm `os` / `cpu` values, which match process.platform / process.arch.
const PLATFORMS = [
  { target: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { target: "darwin-x64", os: "darwin", cpu: "x64" },
  { target: "linux-x64", os: "linux", cpu: "x64" },
  { target: "linux-arm64", os: "linux", cpu: "arm64" },
  { target: "windows-x64", os: "win32", cpu: "x64" },
] as const;

const shared = {
  version: pkg.version,
  license: "Apache-2.0",
  homepage: "https://api.fanvue.com/docs/cli/overview",
  repository: { type: "git", url: "git+https://github.com/fanvue/fanvue-cli.git" },
};

const write = (path: string, json: object) =>
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);

rmSync(OUT, { recursive: true, force: true });

const optionalDependencies: Record<string, string> = {};
for (const { target, os, cpu } of PLATFORMS) {
  const exe = os === "win32" ? ".exe" : "";
  const built = join(ROOT, `dist/public/fanvue-${target}${exe}`);
  if (!existsSync(built)) throw new Error(`Missing ${built}. Run \`bun run build\` first.`);

  const name = `@fanvue/cli-${os}-${cpu}`;
  const dir = join(OUT, `cli-${os}-${cpu}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(built, join(dir, `bin/fanvue${exe}`));
  chmodSync(join(dir, `bin/fanvue${exe}`), 0o755);
  write(join(dir, "package.json"), {
    name,
    ...shared,
    description: `The Fanvue CLI binary for ${os} ${cpu}. Install @fanvue/cli instead.`,
    os: [os],
    cpu: [cpu],
    files: ["bin"],
  });
  optionalDependencies[name] = pkg.version;
}

const launcher = join(OUT, "cli");
mkdirSync(join(launcher, "bin"), { recursive: true });
copyFileSync(join(ROOT, "npm/launcher.cjs"), join(launcher, "bin/fanvue.cjs"));
chmodSync(join(launcher, "bin/fanvue.cjs"), 0o755);
copyFileSync(join(ROOT, "README.md"), join(launcher, "README.md"));
write(join(launcher, "package.json"), {
  name: "@fanvue/cli",
  ...shared,
  description: pkg.description,
  bin: { fanvue: "bin/fanvue.cjs" },
  files: ["bin", "README.md"],
  optionalDependencies,
});

console.log(
  `Packaged @fanvue/cli and ${PLATFORMS.length} platform packages at ${pkg.version} in dist/npm`,
);
