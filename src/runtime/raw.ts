import type { CommandSpec, HttpMethod } from "../commands/types.ts";
import { UsageError } from "./errors.ts";
import type { ApiRequest } from "./request.ts";

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const templateRegex = (template: string) =>
  new RegExp(
    `^${template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`,
  );

/**
 * `fanvue api GET /v1/...`: a raw request, limited to routes the CLI has a command for, so it can't reach an
 * excluded one. Returns the matching command too, so the confirmation gate still applies.
 */
export function buildRawRequest(
  words: string[],
  commands: CommandSpec[],
  data?: Record<string, unknown>,
): { request: ApiRequest; spec: CommandSpec } {
  const [rawMethod, target] = words;
  const method = rawMethod?.toUpperCase() as HttpMethod;
  if (!METHODS.has(method) || !target?.startsWith("/")) {
    throw new UsageError("Usage: fanvue api <GET|POST|PUT|PATCH|DELETE> </v1/path> [--data JSON]");
  }
  const url = new URL(target, "https://api.fanvue.com");
  const spec = commands.find(
    (c) =>
      c.method === method &&
      [c.path, c.creatorPath].some((t) => t && templateRegex(t).test(url.pathname)),
  );
  if (!spec) {
    throw new UsageError(`${method} ${url.pathname} isn't a Fanvue API route the CLI supports.`);
  }
  return {
    spec,
    request: {
      method,
      path: url.pathname,
      query: [...url.searchParams.entries()],
      ...(data ? { body: data } : {}),
    },
  };
}
