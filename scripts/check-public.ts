// Release gate: the public binary must not contain the development host overrides, and the dev
// binary must, which proves the check can fail.
import { $ } from "bun";

const DEV_MARKER = "FANVUE_API_URL";
const host = `${process.platform}-${process.arch}`;
await $`bun run scripts/build.ts --host`.quiet();
await $`bun run scripts/build.ts --host --dev`.quiet();

const publicBinary = await Bun.file(`dist/public/fanvue-${host}`).text();
const devBinary = await Bun.file(`dist/dev/fanvue-${host}`).text();

if (publicBinary.includes(DEV_MARKER)) {
  console.error(
    `Public binary contains "${DEV_MARKER}". Host overrides must stay behind FANVUE_DEV.`,
  );
  process.exit(1);
}
if (!devBinary.includes(DEV_MARKER)) {
  console.error(`Dev binary lacks "${DEV_MARKER}", so this check proves nothing.`);
  process.exit(1);
}
console.log("Public binary contains no development host overrides.");
