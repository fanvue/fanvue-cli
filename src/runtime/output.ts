export type Format = "table" | "json" | "jsonl";

const SECRET_KEYS = /^(access_?token|refresh_?token|id_?token|authorization|client_?secret)$/i;
// Signed CDN and upload links work for anyone holding them until they expire.
const SIGNED_URL =
  /^https?:\/\/\S+[?&](X-Amz-Signature|Signature|Policy|Key-Pair-Id|Expires|se?ig)=/i;
const HIDDEN_URL = "[signed link hidden: add --show-url]";

export function sanitize(value: unknown, showUrls: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, showUrls));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) ? "[hidden]" : sanitize(v, showUrls),
      ]),
    );
  }
  if (typeof value === "string" && !showUrls && SIGNED_URL.test(value)) return HIDDEN_URL;
  return value;
}

function rowsOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : undefined;
}

const PREFERRED = ["uuid", "handle", "displayName", "name", "text", "status", "createdAt"];
const MAX_COLUMNS = 6;
const MAX_WIDTH = 40;

const isPrimitive = (v: unknown) =>
  v === null || ["string", "number", "boolean"].includes(typeof v);
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return s.length > MAX_WIDTH ? `${s.slice(0, MAX_WIDTH - 1)}…` : s;
};

function table(rows: Record<string, unknown>[], source?: string): string {
  if (rows.length === 0) return source ? `No results for \`${source}\`.` : "No results.";
  const keys = [...new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r)))].filter((k) =>
    rows.every((r) => isPrimitive(r[k]) || r[k] === undefined),
  );
  const columns = [
    ...PREFERRED.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !PREFERRED.includes(k)),
  ].slice(0, MAX_COLUMNS);
  if (columns.length === 0) return rows.map((r) => JSON.stringify(r)).join("\n");
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [line(columns), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join("\n");
}

function keyValues(value: Record<string, unknown>): string {
  const width = Math.max(...Object.keys(value).map((k) => k.length));
  return Object.entries(value)
    .map(([k, v]) => `${k.padEnd(width)}  ${isPrimitive(v) ? cell(v) : JSON.stringify(v)}`)
    .join("\n");
}

/** `source` names the command in the empty-table message. */
export function render(value: unknown, format: Format, showUrls = false, source?: string): string {
  const clean = sanitize(value, showUrls);
  if (format === "json") return JSON.stringify(clean, null, 2);
  const rows = rowsOf(clean);
  if (format === "jsonl") {
    return (rows ?? [clean]).map((r) => JSON.stringify(r)).join("\n");
  }
  if (rows) return table(rows as Record<string, unknown>[], source);
  if (clean && typeof clean === "object") return keyValues(clean as Record<string, unknown>);
  return String(clean ?? "");
}
