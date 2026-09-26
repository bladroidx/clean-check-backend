import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

/**
 * The worker's health signal. It serves no port, so "is it healthy" cannot be a request: instead
 * every poll tick that *succeeds* touches a file, and the container healthcheck
 * (`node apps/worker/dist/healthcheck.js`) fails once that file is older than the window.
 *
 * Only successes beat. A worker that is up but whose every tick throws -- the database is gone,
 * a job hangs on an await that never resolves -- is not settling orders, and must not look
 * healthy just because the process has not exited.
 */
export const HEARTBEAT_FILE = process.env['WORKER_HEARTBEAT_FILE'] ?? '/tmp/worker-heartbeat';

/** Ten missed 30 s ticks. Long enough to ride out one slow supplier call, short enough to notice. */
export const HEARTBEAT_MAX_AGE_MS = 5 * 60_000;

export async function beat(file: string = HEARTBEAT_FILE): Promise<void> {
  await writeFile(file, `${Date.now()}\n`);
}

export function isAlive(file: string = HEARTBEAT_FILE, maxAgeMs: number = HEARTBEAT_MAX_AGE_MS): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs < maxAgeMs;
  } catch {
    return false; // no successful tick yet
  }
}
