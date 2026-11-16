#!/usr/bin/env node
// Runs the platform binary that npm installed from this package's optionalDependencies.
// Plain CommonJS so it runs under Node or Bun, whichever installed the package.
const { spawnSync } = require("node:child_process");

const platformPackage = `@fanvue/cli-${process.platform}-${process.arch}`;
const binary = `${platformPackage}/bin/fanvue${process.platform === "win32" ? ".exe" : ""}`;

let path;
try {
  path = require.resolve(binary);
} catch {
  console.error(
    `fanvue: no build for ${process.platform}-${process.arch} was installed (${platformPackage}).\n` +
      "Reinstall without --no-optional or --omit=optional. Supported: macOS (arm64, x64), Linux (arm64, x64), Windows (x64).",
  );
  process.exit(1);
}

const result = spawnSync(path, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`fanvue: couldn't start ${path}: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
