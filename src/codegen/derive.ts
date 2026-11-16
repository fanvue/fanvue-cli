import type { CommandSpec, Field, Gate, HttpMethod } from "../commands/types.ts";
import {
  CREATOR_ALIASES,
  EXCLUDED_PREFIXES,
  FAN_FACING,
  OVERRIDES,
  READ_ONLY_POSTS,
  SECTIONS,
} from "./taxonomy.ts";

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI documents are untyped JSON here.
type Json = any;

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const CREATOR_PREFIX = "/creators/{creatorUserUuid}";

export interface RawOperation {
  method: HttpMethod;
  /** Path as the API serves it, e.g. `/v1/chats`. */
  path: string;
  op: Json;
}

export function listOperations(doc: Json): RawOperation[] {
  const out: RawOperation[] = [];
  for (const [path, item] of Object.entries<Json>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method.toLowerCase()];
      if (op) out.push({ method, path, op });
    }
  }
  return out;
}

/** `/v1/creators/{creatorUserUuid}/posts` → `/posts`. */
export function normalisePath(path: string): string {
  const unversioned = path.replace(/^\/v1(?=\/)/, "");
  if (!unversioned.startsWith(`${CREATOR_PREFIX}/`)) return unversioned;
  const stripped = unversioned.slice(CREATOR_PREFIX.length);
  return CREATOR_ALIASES[stripped] ?? stripped;
}

export function isCreatorScoped(path: string): boolean {
  return path.replace(/^\/v1(?=\/)/, "").startsWith(`${CREATOR_PREFIX}/`);
}

export function isExcluded(path: string): boolean {
  const p = normalisePath(path);
  return EXCLUDED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

const isParam = (segment: string) => segment.startsWith("{");

/**
 * Derives the command words for one normalised path. `siblings` is every normalised
 * `METHOD path` in the document, used to tell a sub-collection from an action.
 */
export function commandFor(method: HttpMethod, path: string, siblings: Set<string>): string[] {
  const key = `${method} ${path}`;
  const override = OVERRIDES[key];
  if (override) return override;

  const section = SECTIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  if (!section) throw new Error(`No section for ${key}. Add one to taxonomy.ts.`);
  const [prefix, base] = section;
  const tail = path.slice(prefix.length).split("/").filter(Boolean);
  const nouns = [...base, ...tail.filter((s) => !isParam(s))];
  const last = tail.at(-1);

  if (last !== undefined && isParam(last)) {
    const verb = { GET: "get", POST: "add", PUT: "update", PATCH: "update", DELETE: "delete" };
    return [...nouns, verb[method]];
  }

  const hasChildren = [...siblings].some((s) => s.split(" ")[1]?.startsWith(`${path}/{`));
  const readable = siblings.has(`GET ${path}`);

  if (last !== undefined && !readable && !hasChildren) {
    // An action such as `/posts/{uuid}/pin`: the last word is the verb.
    const action = method === "DELETE" ? `un${last}` : last;
    return [...nouns.slice(0, -1), action];
  }

  if (method === "GET") return hasChildren ? [...nouns, "list"] : nouns;
  if (method === "POST") return [...nouns, hasChildren ? "create" : "add"];
  if (method === "DELETE") return [...nouns, "delete"];
  return [...nouns, "set"];
}

function resolve(doc: Json, node: Json): Json {
  let current = node;
  while (current?.$ref) {
    const parts = String(current.$ref).replace(/^#\//, "").split("/");
    current = parts.reduce((acc: Json, part: string) => acc?.[part], doc);
  }
  return current;
}

function typeOf(doc: Json, schema: Json): string {
  const s = resolve(doc, schema) ?? {};
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
  if (type === "array") return `array of ${typeOf(doc, s.items)}`;
  if (type) return String(type);
  if (s.properties || s.allOf || s.oneOf || s.anyOf) return "object";
  return "string";
}

function queryFields(doc: Json, op: Json): Field[] {
  return (op.parameters ?? [])
    .map((p: Json) => resolve(doc, p))
    .filter((p: Json) => p?.in === "query")
    .map((p: Json) => ({
      name: p.name,
      required: Boolean(p.required),
      type: typeOf(doc, p.schema),
      ...(p.description ? { description: String(p.description) } : {}),
    }));
}

function bodyOf(doc: Json, op: Json): CommandSpec["body"] {
  const body = resolve(doc, op.requestBody);
  const schema = resolve(doc, body?.content?.["application/json"]?.schema);
  if (!schema) return undefined;
  const required = new Set<string>(schema.required ?? []);
  const fields = Object.entries<Json>(schema.properties ?? {}).map(([name, prop]) => {
    const resolved = resolve(doc, prop);
    return {
      name,
      required: required.has(name),
      type: typeOf(doc, prop),
      ...(resolved?.description ? { description: String(resolved.description) } : {}),
    };
  });
  return { required: Boolean(body?.required), fields };
}

function scopesOf(op: Json): string[] {
  return (op.security ?? []).flatMap((s: Json) => Object.values<string[]>(s).flat());
}

function gateOf(method: HttpMethod, normalised: string): Gate {
  const key = `${method} ${normalised}`;
  if (method === "GET" || READ_ONLY_POSTS.has(key)) return "read";
  return FAN_FACING.has(key) ? "fan-facing" : "write";
}

interface Grouped {
  doc: Json;
  self?: RawOperation;
  creator?: RawOperation;
}

/** Pairs each self-scoped route with its creator-scoped twin. The first document wins. */
function groupOperations(docs: Json[]): Map<string, Grouped> {
  const byKey = new Map<string, Grouped>();
  for (const doc of docs) {
    for (const raw of listOperations(doc)) {
      if (isExcluded(raw.path)) continue;
      const key = `${raw.method} ${normalisePath(raw.path)}`;
      const entry = byKey.get(key) ?? { doc };
      if (entry.doc !== doc) continue;
      if (isCreatorScoped(raw.path)) entry.creator ??= raw;
      else entry.self ??= raw;
      byKey.set(key, entry);
    }
  }
  return byKey;
}

function toCommandSpec(
  primary: RawOperation,
  { doc, self, creator }: Grouped,
  normalised: string,
  siblings: Set<string>,
): CommandSpec {
  const { method, op } = primary;
  const body = bodyOf(doc, op);
  const args = (primary.path.match(/\{[^}]+\}/g) ?? [])
    .map((p) => p.slice(1, -1))
    .filter((p) => p !== "creatorUserUuid");
  return {
    operationId: String(op.operationId),
    command: commandFor(method, normalised, siblings),
    args,
    method,
    path: self?.path ?? primary.path,
    ...(creator ? { creatorPath: creator.path } : {}),
    query: queryFields(doc, op),
    ...(body ? { body } : {}),
    scopes: scopesOf(op),
    gate: gateOf(method, normalised),
    summary: String(op.summary ?? ""),
  };
}

/**
 * Turns OpenAPI documents into command specs. The first document wins on duplicates, so pass
 * v1 before v0; v0 only adds the routes v1 lacks.
 */
export function deriveCommands(docs: Json[]): CommandSpec[] {
  const byKey = groupOperations(docs);
  const siblings = new Set(byKey.keys());
  const commands: CommandSpec[] = [];
  for (const [key, entry] of byKey) {
    const primary = entry.self ?? entry.creator;
    if (!primary) continue;
    commands.push(toCommandSpec(primary, entry, key.slice(key.indexOf(" ") + 1), siblings));
  }
  return commands.sort((a, b) => a.command.join(" ").localeCompare(b.command.join(" ")));
}
