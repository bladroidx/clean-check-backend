import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DISCLAIMER,
  SCHEMA_VERSION,
  deriveVerdict,
  type Capability,
  type CheckReport,
} from '@imei-check/contract';
import { Imei } from '@imei-check/identity';
import type { CheckSummary, Tenant } from '@imei-check/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { tenantOf } from '../auth/plugin.js';
import { reasonsFor } from '../orchestrator/run-check.js';
import type { AppServices } from '../services.js';

/**
 * What the free and the deep check routes share: rate, Luhn, depth, idempotency -- and the GET body.
 *
 * Two rules govern the HTTP layer here and both are about not lying:
 *
 * - **200 whenever the request was well-formed and authorised**, even if every section came back
 *   `unavailable`. A 502 is indistinguishable to a naive client from "nothing wrong found", and
 *   the four arms exist precisely so that "we could not tell you" is expressible in the body.
 * - **`Idempotency-Key` is mandatory.** A retried deep check that runs twice buys twice; one that
 *   returns a different answer breaks the promise the header makes. Both are fixed by replaying
 *   the stored response.
 *
 * Idempotency is scoped per tier: the stored key is `free:<key>` or `deep:<key>` and the request
 * digest includes the tier, so the same key on both routes is two requests, not a conflict.
 */

export const IdempotentHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(8)
    .max(200)
    .describe('Required. A retry with the same key returns the first response and does not re-run it.'),
});

export const CheckParams = z.object({ id: z.string().min(3).max(80) });

export type Tier = 'free' | 'deep';

export interface CheckPostArgs {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly services: AppServices;
  readonly tier: Tier;
  /** The IMEI text exactly as the caller sent it; parsed (and Luhn-gated) here. */
  readonly imeiText: string;
  readonly idempotencyKey: string;
  readonly capabilities: readonly Capability[];
  /** Runs the check. Whatever it returns is what a retry of this key replays. */
  readonly run: (ctx: { tenant: Tenant; imei: Imei; idempotencyKey: string }) => Promise<CheckReport>;
}

export async function handleCheckPost(args: CheckPostArgs): Promise<FastifyReply> {
  const { request, reply, services, tier } = args;
  const tenant = tenantOf(request);

  const rate = services.limiter.take(`checks:${tenant.id}`, services.limits.checks);
  if (!rate.allowed) {
    return reply
      .code(429)
      .header('retry-after', String(rate.retryAfterSeconds))
      .send({
        error: {
          code: 'rate_limited',
          message: `Too many checks. Retry in ${rate.retryAfterSeconds}s.`,
          request_id: request.id,
        },
      });
  }

  const parsed = Imei.parse(args.imeiText);
  if (parsed.kind !== 'valid') {
    // The Luhn gate BEFORE any paid call. Free, and it kills most random enumeration -- which
    // matters because every deep call past this point spends our money.
    return reply.code(400).send({
      error: {
        code: 'invalid_imei',
        message:
          parsed.kind === 'checksum_failed'
            ? 'The check digit does not match. One of the digits is wrong.'
            : parsed.kind === 'wrong_length'
              ? `An IMEI is 15 digits; ${parsed.digitsFound} were found.`
              : 'No digits were found in the text supplied.',
        request_id: request.id,
      },
    });
  }

  const imei = parsed.imei;
  const scopedKey = `${tier}:${args.idempotencyKey}`;

  // Binds the key to the request. A client reusing one key for a different IMEI has a bug;
  // silently serving them the previous device's report would be one on our side.
  const requestDigest = createHash('sha256')
    .update(`${tier}|${imei.hmac(services.pepper)}|${[...args.capabilities].sort().join(',')}`, 'utf8')
    .digest('hex');

  /**
   * Depth, where the token bucket above is rate.
   *
   * Taken BEFORE the idempotency claim on purpose: refusing after claiming would leave a claimed
   * row with no stored response, and every retry of that key would then answer
   * `check_in_progress` forever. Refusing first leaves nothing behind to retry around.
   */
  if (!services.concurrency.tryAcquire(tenant.id, services.maxConcurrentChecks)) {
    return reply
      .code(429)
      .header('retry-after', '1')
      .send({
        error: {
          code: 'too_many_concurrent_checks',
          message:
            `At most ${services.maxConcurrentChecks} checks may be in flight at once on ` +
            'this account. Retry when one finishes.',
          request_id: request.id,
        },
      });
  }

  try {
    const claim = await services.repos.idempotency.claim({
      tenantId: tenant.id,
      key: scopedKey,
      requestDigest,
    });

    if (!claim.claimed) {
      const existing = claim.existing;
      if (existing.requestDigest !== requestDigest) {
        return reply.code(409).send({
          error: {
            code: 'idempotency_key_reused',
            message: 'This Idempotency-Key was already used for a different request. Use a new key.',
            request_id: request.id,
          },
        });
      }
      if (existing.responseBody === undefined || existing.responseBody === null) {
        // The first attempt is still in flight. Telling the client to retry is honest and costs
        // nothing; returning a half-built report would not be.
        return reply.code(409).send({
          error: {
            code: 'check_in_progress',
            message: 'A check with this Idempotency-Key is still running. Retry shortly.',
            request_id: request.id,
          },
        });
      }
      // The stored response, replayed verbatim. Re-running it would buy twice; recomputing it
      // could answer differently for the same key.
      return reply.code(200).send(existing.responseBody as CheckReport);
    }

    const report = await args.run({ tenant, imei, idempotencyKey: args.idempotencyKey });

    // The FINAL report -- for a deep check, the one after the wait window -- so a retry replays
    // what the caller would have seen, not the provisional answer from before the wait.
    await services.repos.idempotency.complete(tenant.id, scopedKey, {
      checkId: report.check_id,
      statusCode: 200,
      responseBody: report,
    });

    // 200 even when every section is unavailable. Invariant 7.
    return reply.code(200).send(report);
  } finally {
    // `finally`, not a call on each exit path: a throw from the check that did not release would
    // permanently consume one of the tenant's slots until the process restarted.
    services.concurrency.release(tenant.id);
  }
}

/**
 * A stored check, as a report. Shared by both GET routes; reads our database only, never a
 * supplier.
 *
 * `summary.reasons` is rebuilt from the stored sections with the same function the POST used.
 * An empty list reads as "nothing to say", which is never true of a report with sections in it.
 */
export async function reportFromRecord(services: AppServices, record: CheckSummary): Promise<CheckReport> {
  const stored = await services.repos.checks.sections(record.id);
  const list = stored.map((s) => s.section);
  const sections = Object.fromEntries(stored.map((s) => [s.capability, s.section])) as CheckReport['sections'];

  return {
    schema_version: SCHEMA_VERSION,
    check_id: record.id,
    status: record.status,
    subject: {
      imei_masked: record.imeiMasked,
      imei_hash: record.subjectHash,
      ...(record.tac !== undefined ? { tac: record.tac } : {}),
      luhn_valid: true,
    },
    requested_at: record.createdAt.toISOString(),
    completed_at: record.completedAt?.toISOString() ?? null,
    sections,
    summary: {
      // Derived from the stored sections, never read back from the column: sections land one at a
      // time (poll, webhook, wait window) and a verdict that lags them could show a `fail` section
      // under an amber summary (final review F5). Same function the POST used, same answer.
      verdict: deriveVerdict(list).verdict,
      reasons: reasonsFor(list),
      sections_unavailable: stored.filter((s) => s.outcome === 'unavailable').map((s) => s.capability),
    },
    billing: { credits_charged: record.creditsCharged, breakdown: [] },
    disclaimer: DISCLAIMER,
  };
}

/** GET body shared by both tiers: 404 unless the id is this tenant's AND this tier's. */
export async function getCheck(
  request: FastifyRequest,
  reply: FastifyReply,
  services: AppServices,
  args: { readonly id: string; readonly tier: Tier },
): Promise<FastifyReply> {
  const tenant = tenantOf(request);
  const record = await services.repos.checks.byId(tenant.id, args.id, args.tier);
  if (record === undefined) {
    return reply.code(404).send({
      error: {
        code: 'check_not_found',
        message: 'No such check for this account.',
        request_id: request.id,
      },
    });
  }
  return reply.code(200).send(await reportFromRecord(services, record));
}

/** Ties the provider calls to the client connection: a hung-up caller stops costing us money. */
export function toSignal(raw: { destroyed?: boolean; on?: (e: string, cb: () => void) => unknown }): AbortSignal {
  const controller = new AbortController();
  if (raw.destroyed === true) controller.abort();
  else raw.on?.('aborted', () => controller.abort());
  return controller.signal;
}
