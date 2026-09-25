import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * dependency-cruiser works on module imports, not on which functions a module calls once it gets
 * there, so it cannot express "only this file may call `createCipheriv`". This test enforces the
 * ADR-0007 boundary directly: `packages/core/src/crypto/imei-cipher.ts` is the ONE place an IMEI
 * is encrypted or decrypted, in the whole workspace.
 */

const ALLOWED = join('packages', 'core', 'src', 'crypto', 'imei-cipher.ts');
const PATTERN = /createCipheriv|createDecipheriv/;

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, root, out);
    } else if (entry.endsWith('.ts')) {
      out.push(relative(root, full));
    }
  }
}

describe('cipher boundary (ADR-0007)', () => {
  it('only imei-cipher.ts uses the raw AES-GCM primitives', () => {
    // Two levels up from packages/core/test is the repo root.
    const root = join(import.meta.dirname, '..', '..', '..');
    const files: string[] = [];
    for (const pkgDir of readdirSync(join(root, 'packages'))) {
      const src = join(root, 'packages', pkgDir, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src, root, files);
      } catch {
        // no src dir -- nothing to scan
      }
    }
    for (const appDir of readdirSync(join(root, 'apps'))) {
      const src = join(root, 'apps', appDir, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src, root, files);
      } catch {
        // no src dir -- nothing to scan
      }
    }

    const offenders = files.filter((f) => {
      if (f === ALLOWED) return false;
      return PATTERN.test(readFileSync(join(root, f), 'utf8'));
    });
    expect(offenders).toEqual([]);
  });
});
