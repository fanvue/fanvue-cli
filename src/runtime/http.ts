import { API_VERSION } from "../commands/api-version.gen.ts";
import { VERSION } from "../version.ts";
import { ApiError } from "./errors.ts";
import type { ApiRequest } from "./request.ts";

export { API_VERSION };
export const API_BASE_URL = "https://api.fanvue.com";
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 60;

export interface ClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  debug?: (line: string) => void;
}

export function toUrl(request: ApiRequest, baseUrl = API_BASE_URL): string {
  const url = new URL(request.path, baseUrl);
  for (const [k, v] of request.query) url.searchParams.append(k, v);
  return url.toString();
}

function requestInit(request: ApiRequest, token: string, idempotencyKey?: string): RequestInit {
  return {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Fanvue-API-Version": API_VERSION,
      "User-Agent": `fanvue-cli/${VERSION}`,
      Accept: "application/json",
      ...(request.body ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  };
}

/**
 * Sends one request. Retries 429s only for requests that can't change anything, honouring
 * Retry-After, so a write is never sent twice.
 */
export async function send(
  request: ApiRequest,
  options: ClientOptions,
  { retry429 }: { retry429: boolean },
): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? Bun.sleep;
  const url = toUrl(request, options.baseUrl);
  // One key per logical write, reused by any retry, so a retry after a timeout can't apply
  // the change twice where Styx honours it.
  const init = requestInit(
    request,
    options.token,
    request.method === "GET" ? undefined : crypto.randomUUID(),
  );

  for (let attempt = 0; ; attempt++) {
    options.debug?.(`${request.method} ${url} (Authorization: Bearer [hidden])`);
    const res = await doFetch(url, init);

    if (res.status === 429 && retry429 && attempt < MAX_RETRIES) {
      const seconds = Math.min(
        Number(res.headers.get("Retry-After")) || 1,
        MAX_RETRY_AFTER_SECONDS,
      );
      options.debug?.(`429, retrying in ${seconds}s`);
      await sleep(seconds * 1000);
      continue;
    }

    const text = await res.text();
    const body: unknown = text ? safeJson(text) : null;
    if (!res.ok) throw new ApiError(res.status, body, request.body ? "body" : "query");
    return body;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Follows `nextCursor` until the API stops returning one. */
export async function sendAll(request: ApiRequest, options: ClientOptions): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = (await send(
      {
        ...request,
        query: [
          ...request.query.filter(([k]) => k !== "cursor"),
          ...(cursor ? [["cursor", cursor] as [string, string]] : []),
        ],
      },
      options,
      { retry429: true },
    )) as { data?: unknown[]; nextCursor?: string | null };
    items.push(...(page.data ?? []));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}
