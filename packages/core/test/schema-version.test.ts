import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_SCHEMA_VERSION, checkDatabase } from '../src/db/pg.js';

/**
 * The readiness probe, and the constant it rests on.
 *
 * `REQUIRED_SCHEMA_VERSION` is hand-maintained by necessity -- the deploy artefact does not ship
 * `db/migrations/`, so the running service cannot derive it. That makes it exactly the kind of
 * thing this repo enforces with a test rather than a comment, alongside the sentinel test and the
 * boundary check: a migration added without bumping the constant fails here, at the moment it is
 * written, rather than as a `/readyz` that lies in production.
 */

const MIGRATIONS = join(import.meta.dirname, '..', '..', '..', 'db', 'migrations');

describe('REQUIRED_SCHEMA_VERSION', () => {
  it('matches the newest migration on disk', () => {
    const versions = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, 14))
      .filter((v) => /^\d{14}$/.test(v))
      .sort();

    expect(versions.length).toBeGreaterThan(0);
    expect(REQUIRED_SCHEMA_VERSION).toBe(versions.at(-1));
  });
});

/**
 * A stub rather than a container: the branches worth pinning here are the failure ones, and none
 * of them needs a real Postgres to reach. A probe that cannot distinguish "unmigrated" from
 * "unreachable" sends an operator down the wrong path during an incident.
 */
function poolStub(behaviour: () => Promise<{ rows: unknown[] }>): Parameters<typeof checkDatabase>[0] {
  return { query: behaviour } as unknown as Parameters<typeof checkDatabase>[0];
}

describe('checkDatabase', () => {
  it('is ready when the required migration is present', async () => {
    const result = await checkDatabase(
      poolStub(async () => ({ rows: [{ latest: '20260913000001', required_applied: true }] })),
    );
    expect(result).toEqual({
      reachable: true,
      migrationsCurrent: true,
      appliedVersion: '20260913000001',
    });
  });

  it('is behind when a NEWER migration is applied but the required one is not', async () => {
    // The interleaved-timestamp merge: `max(version)` would clear the bar while the table this
    // build needs does not exist. Checking for the exact version is what catches it.
    const result = await checkDatabase(
      poolStub(async () => ({ rows: [{ latest: '20260914000001', required_applied: false }] })),
    );
    expect(result.reachable).toBe(true);
    expect(result.migrationsCurrent).toBe(false);
    expect(result.appliedVersion).toBe('20260914000001');
  });

  it('reads a missing schema_migrations as reachable-but-unmigrated', async () => {
    // dbmate has never run here. That is a different operator action from a database being down.
    const result = await checkDatabase(
      poolStub(() => Promise.reject(Object.assign(new Error('no such table'), { code: '42P01' }))),
    );
    expect(result).toEqual({ reachable: true, migrationsCurrent: false, appliedVersion: undefined });
  });

  it('reads a refused connection as unreachable', async () => {
    const result = await checkDatabase(
      poolStub(() => Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))),
    );
    expect(result.reachable).toBe(false);
  });

  it('gives up on an unresponsive database instead of hanging the probe', async () => {
    // A probe that waits on a wedged database reads to the orchestrator as the whole process
    // being unresponsive, which restarts pods that were serving the free tier perfectly well.
    const started = Date.now();
    const result = await checkDatabase(
      poolStub(() => new Promise(() => {})),
      25,
    );
    expect(result.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
