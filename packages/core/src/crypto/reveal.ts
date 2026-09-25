import { randomUUID } from 'node:crypto';
import { scrub } from '@imei-check/providers';
import type { Repositories } from '../db/types.js';
import type { ImeiCipher } from './imei-cipher.js';

/**
 * The one code path that reveals a stored IMEI (ADR-0007). Shared by
 * `POST /v1/admin/checks/:id/imei/reveal` and `npm run imei:reveal`, so the audit-before-decrypt
 * ordering cannot drift between the HTTP route and the CLI.
 *
 * The audit row is written BEFORE decryption, and its failure is NOT caught here: a caller that
 * cannot write the audit row must not decrypt, and the only way to guarantee that is to let the
 * write's own exception propagate past this function with nothing decrypted yet.
 */

export type RevealResult =
  | { readonly kind: 'revealed'; readonly imei: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_stored' };

export interface RevealImeiDeps {
  readonly repos: Repositories;
  readonly cipher: ImeiCipher;
  readonly now?: () => Date;
}

export interface RevealImeiArgs {
  readonly tenantId: string;
  readonly checkId: string;
  /** `api:<key id>` for the HTTP route, `cli` for the script. */
  readonly actor: string;
  readonly reason: string;
}

/**
 * A person reading an IMEI aloud or off a box types it grouped -- `35 310411 234567 6`,
 * `35-310411-234567-6` -- and the provider scrubber only knows unbroken digit runs. So digit runs
 * of IMEI length (14+ digits) broken only by spaces or hyphens are redacted first, then the plain
 * rule runs. A date or a ticket number is far too short to match.
 */
const SEPARATED_IMEI = /(?<!\d)\d(?:[ \t-]*\d){13,}(?!\d)/g;

export function scrubReason(reason: string): string {
  return scrub(reason.replace(SEPARATED_IMEI, '[REDACTED-IMEI]'));
}

export async function revealImei(deps: RevealImeiDeps, args: RevealImeiArgs): Promise<RevealResult> {
  const check = await deps.repos.checks.byId(args.tenantId, args.checkId);
  if (check === undefined) return { kind: 'not_found' };

  const ciphertext = await deps.repos.checks.encryptedImei(args.checkId);
  if (ciphertext === undefined) return { kind: 'not_stored' };

  // Audit BEFORE decrypt. If this throws (e.g. the append-only table rejects the write, or the
  // database is unreachable), it propagates to the caller and `cipher.decrypt` below never runs.
  //
  // The reason is free text a caller typed, and free text is exactly where a raw IMEI leaks in --
  // "reveal because <the device's IMEI> was reported stolen" would otherwise sit in `imei_reveals`
  // forever. Scrub it -- the providers' IMEI-shaped-digit-run rule, plus grouped forms -- before it
  // is ever written, not after.
  await deps.repos.reveals.record({
    id: `rev_${randomUUID()}`,
    checkId: args.checkId,
    actor: args.actor,
    reason: scrubReason(args.reason),
    revealedAt: (deps.now ?? (() => new Date()))(),
  });

  const imei = deps.cipher.decrypt(ciphertext.imeiEncrypted, ciphertext.imeiKeyVersion, args.checkId);
  return { kind: 'revealed', imei };
}
