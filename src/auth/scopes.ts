/**
 * What `fanvue login` asks the CLI service for. The service maps `fanvue_cli:read` to every Fanvue
 * `read:*` scope and `fanvue_cli:write` adds every `write:*`, never `write:payments`.
 */
const BASE = ["openid", "offline_access", "fanvue_cli:read"];

export const scopesFor = (write: boolean) => (write ? [...BASE, "fanvue_cli:write"] : BASE);

/** Account types the CLI serves. Fan-only accounts are refused before anything is stored. */
export const SUPPORTED_ROLES = ["creator", "agency", "agency_admin"];
