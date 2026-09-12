#!/usr/bin/env node
/**
 * Diff the emitted JSON Schema against the committed snapshot.
 *
 * A schema change with no snapshot diff in the pull request is a schema change nobody reviewed.
 * The classification is deliberately conservative: a new enum arm counts as BREAKING, because the
 * shipped Kotlin client's `when` is exhaustive and fails closed on a value it has never seen.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SNAPSHOT = 'packages/contract/snapshots/v1.0.json';

if (!existsSync(SNAPSHOT)) {
  console.error(`No snapshot at ${SNAPSHOT}. Run: npm run schema:emit`);
  process.exit(1);
}

const committed = execSync(`git show HEAD:${SNAPSHOT} 2>/dev/null || echo '{}'`, {
  encoding: 'utf8',
  shell: '/bin/bash',
});
const before = JSON.parse(committed || '{}');
const after = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));

const flatten = (obj, prefix = '', out = new Map()) => {
  if (obj === null || typeof obj !== 'object') { out.set(prefix, obj); return out; }
  if (Array.isArray(obj)) { out.set(prefix, JSON.stringify(obj)); return out; }
  for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
};

const a = flatten(before);
const b = flatten(after);
const additive = [];
const breaking = [];

for (const [k, v] of b) {
  if (!a.has(k)) {
    (k.endsWith('.enum') ? breaking : additive).push(
      `+ ${k} = ${String(v).slice(0, 80)}${k.endsWith('.enum') ? '   (new enum arm: exhaustive clients fail closed)' : ''}`,
    );
  } else if (a.get(k) !== v) {
    breaking.push(`~ ${k}: ${String(a.get(k)).slice(0, 40)} -> ${String(v).slice(0, 40)}`);
  }
}
for (const k of a.keys()) if (!b.has(k)) breaking.push(`- ${k}  (removed)`);

console.log(`SCHEMA DIFF vs ${SNAPSHOT}`);
console.log(`  additive: ${additive.length}`);
additive.slice(0, 20).forEach((l) => console.log(`    ${l}`));
console.log(`  breaking: ${breaking.length}`);
breaking.slice(0, 20).forEach((l) => console.log(`    ${l}`));

if (breaking.length > 0) {
  console.log('\nVERDICT: REQUIRES a new path version (/vN) plus a Sunset plan on the old one.');
  console.log('See .claude/skills/api-versioning/SKILL.md');
  process.exit(process.env.SCHEMA_DIFF_SOFT ? 0 : 1);
}
console.log('\nVERDICT: additive only — bump schema_version minor and commit the snapshot.');
