export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** How much confirmation a command needs before it sends. */
export type Gate = "read" | "write" | "fan-facing";

export interface Field {
  name: string;
  required: boolean;
  /** JSON Schema type; "object" and "array of object" fields take JSON on the command line. */
  type: string;
  description?: string;
}

export interface CommandSpec {
  operationId: string;
  /** Words after `fanvue`, e.g. ["messages", "send"]. */
  command: string[];
  /** Path parameters, in path order. They become positional arguments. */
  args: string[];
  method: HttpMethod;
  path: string;
  /** The `/creators/{creatorUserUuid}/...` twin, used when `--creator` is set. */
  creatorPath?: string;
  query: Field[];
  body?: { required: boolean; fields: Field[] };
  scopes: string[];
  gate: Gate;
  summary: string;
}
