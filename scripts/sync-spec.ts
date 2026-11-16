// Pulls the public OpenAPI documents Styx serves. They are the source of truth; the docs site
// copies the same documents.
const SPEC_URL = "https://api.fanvue.com/openapi";
const SPEC_DIR = new URL("../spec/", import.meta.url);

// Codegen reads paths, parameters and request bodies. Responses, examples and long operation
// descriptions are most of each document's size, so they aren't kept.
const DROP_KEYS = new Set(["responses", "example", "examples", "x-codeSamples"]);

function trim(node: unknown, isOperation = false): unknown {
  if (Array.isArray(node)) return node.map((n) => trim(n));
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => !DROP_KEYS.has(k) && !(isOperation && k === "description"))
      .map(([k, v]) => [k, k === "paths" ? trimPaths(v) : trim(v)]),
  );
}

function trimPaths(paths: unknown): unknown {
  return Object.fromEntries(
    Object.entries(paths as Record<string, Record<string, unknown>>).map(([path, item]) => [
      path,
      Object.fromEntries(Object.entries(item).map(([method, op]) => [method, trim(op, true)])),
    ]),
  );
}

async function sync(url: string, out: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const doc = trim(await res.json()) as { paths?: object; components?: Record<string, unknown> };
  if (!doc.paths || Object.keys(doc.paths).length === 0) {
    throw new Error(`${url} has no paths. Refusing to overwrite spec/${out}.`);
  }
  if (doc.components) delete doc.components.responses;
  await Bun.write(new URL(out, SPEC_DIR), `${JSON.stringify(doc, null, 2)}\n`);
}

// v1 is the current URL version. The unversioned document adds the routes v1 lacks (/apps/*).
await sync(`${SPEC_URL}?version=v1`, "v1.json");
await sync(SPEC_URL, "v0.json");
await Bun.write(
  new URL("source.json", SPEC_DIR),
  `${JSON.stringify({ source: SPEC_URL, syncedAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`Synced spec/v1.json and spec/v0.json from ${SPEC_URL}`);
