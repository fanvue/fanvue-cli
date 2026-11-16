import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "../runtime/errors.ts";

export interface LockOptions {
  /** A lock older than this belongs to a process that died; take it over. */
  staleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, `${process.pid} ${Date.now()}`);
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function isStale(path: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` while holding an exclusive lock file, so only one fanvue process refreshes a
 * session at a time. Refresh tokens are single-use; two processes presenting the same one
 * outside the server's grace window revoke the whole session.
 */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  { staleMs = 30_000, timeoutMs = 15_000, pollMs = 50 }: LockOptions = {},
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  while (!tryCreate(path)) {
    if (isStale(path, staleMs)) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    if (Date.now() - started > timeoutMs) {
      throw new CliError("Another fanvue process is refreshing your session. Try again.");
    }
    await Bun.sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}
