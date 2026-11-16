import { $ } from "bun";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;

const args = Bun.argv.slice(2);
// Dev builds take FANVUE_API_URL, FANVUE_AUTH_URL and FANVUE_STYX_URL to target another stage.
// Public builds always use the production hosts and don't contain the override code.
const dev = args.includes("--dev");
const hostOnly = args.includes("--host");
const targets = hostOnly ? [`bun-${process.platform}-${process.arch}`] : TARGETS;
const variant = dev ? "dev" : "public";

for (const target of targets) {
  const outfile = `dist/${variant}/fanvue-${target.replace("bun-", "")}${target.includes("windows") ? ".exe" : ""}`;
  await $`bun build src/index.ts --compile --minify --target=${target} --define FANVUE_DEV=${String(dev)} --outfile ${outfile}`.quiet();
  console.log(`built ${outfile}`);
}
