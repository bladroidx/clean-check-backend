import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beat, isAlive } from '../src/heartbeat.js';

const dirs: string[] = [];
function heartbeatFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worker-heartbeat-'));
  dirs.push(dir);
  return join(dir, 'heartbeat');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('worker heartbeat', () => {
  it('is not alive before the first successful tick', () => {
    // A worker that has never completed a poll is not healthy just because it has not crashed.
    expect(isAlive(heartbeatFile(), 300_000)).toBe(false);
  });

  it('is alive right after a successful tick', async () => {
    const file = heartbeatFile();
    await beat(file);
    expect(isAlive(file, 300_000)).toBe(true);
  });

  it('goes stale when no tick has succeeded within the window', async () => {
    // A hung job or a database that stays down stops the beats; the file's age is the signal.
    const file = heartbeatFile();
    await beat(file);
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
    utimesSync(file, sixMinutesAgo, sixMinutesAgo);
    expect(isAlive(file, 300_000)).toBe(false);
  });
});
