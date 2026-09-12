import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CheckRequest,
  CheckReport,
  Capability,
  DISCLAIMER,
  ErrorResponse,
  SCHEMA_VERSION,
} from '@imei-check/contract';
import { Imei } from '@imei-check/identity';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { tenantOf } from '../auth/plugin.js';
import { runCheck } from '../orchestrator/run-check.js';
import type { AppServices } from '../services.js';

/**
 * The paid path.
 *
 * Two rules govern the HTTP layer here and both are about not lying:
 *
 * - **200 whenever the request was well-formed and authorised**, even if every section came back
 *   `unavailable`. A 502 is indistinguishable to a naive client from "nothing wrong found", and
 *   the four arms exist precisely so that "we could not tell you" is expressible in the body.
 * - **`Idempotency-Key` is mandatory.** A retried paid check that runs twice charges twice; one
 *   that returns a different answer breaks the promise the header makes. Both are fixed by
 *   replaying the stored first response.
 */

const IdempotentHeaders = z.object({
  'idempotency-key': z
    .string()
    .min(8)
    .max(200)
    .describe('Required. A retry with the same key returns the first response and does not re-charge.'),
});

const CheckParams = z.object({ id: z.string().min(3).max(80) });

export function checkRoutes(services: AppServices): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/v1/checks',
      {
        preHandler: app.requireTenant,
        schema: {
          summary: 'Run a check against an IMEI. Costs credits.',
          tags: ['paid'],
          headers: IdempotentHeaders,
          body: CheckRequest,
          response: {
            200: CheckReport,
            400: ErrorResponse,
            401: ErrorResponse,
            409: ErrorResponse,
            429: ErrorResponse,
          },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const idempotencyKey = request.headers['idempotency-key'];

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

        const parsed = Imei.parse(request.body.imei);
        if (parsed.kind !== 'valid') {
          // The Luhn gate BEFORE any paid call. Free, and it kills most random enumeration --
          // which matters because every paid call past this point spends our money.
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
        const requested = request.body.capabilities ?? services.defaultCapabilities;

        // Binds the key to the request. A client reusing one key for a different IMEI has a bug;
        // silently serving them the previous device's report would be one on our side.
        const requestDigest = createHash('sha256')
          .update(`${imei.hmac(services.pepper)}|${[...requested].sort().join(',')}`, 'utf8')
          .digest('hex');

        const claim = await services.repos.idempotency.claim({
          tenantId: tenant.id,
          key: idempotencyKey,
          requestDigest,
        });

        if (!claim.claimed) {
          const existing = claim.existing;
          if (existing.requestDigest !== requestDigest) {
            return reply.code(409).send({
              error: {
                code: 'idempotency_key_reused',
                message:
                  'This Idempotency-Key was already used for a different request. Use a new key.',
                request_id: request.id,
              },
            });
          }
          if (existing.responseBody === undefined || existing.responseBody === null) {
            // The first attempt is still in flight. Telling the client to retry is honest and
            // costs nothing; returning a half-built report would not be.
            return reply.code(409).send({
              error: {
                code: 'check_in_progress',
                message: 'A check with this Idempotency-Key is still running. Retry shortly.',
                request_id: request.id,
              },
            });
          }
          // The stored first response, replayed verbatim. Re-running it would charge twice;
          // recomputing it could answer differently for the same key.
          return reply.code(200).send(existing.responseBody as CheckReport);
        }

        const guard = await services.enumeration.observe({
          tenantId: tenant.id,
          tac: imei.typeAllocationCode,
          imeiDigits: imei.digits,
          now: new Date(),
        });

        if (guard.level === 'suspended') {
          return reply.code(429).send({
            error: {
              code: 'account_restricted',
              message:
                'Paid lookups are suspended on this account after an unusual volume of sequential ' +
                'IMEIs. Contact support.',
              request_id: request.id,
            },
          });
        }

        const report = await runCheck(
          {
            repos: services.repos,
            router: services.router,
            cache: services.cache,
            tacDirectory: app.tacDirectory,
            metrics: services.metrics,
          },
          {
            tenantId: tenant.id,
            tenantSalt: tenant.imeiSalt,
            imei,
            imeiHash: imei.hmac(services.pepper),
            capabilities: requested,
            maxAgeSeconds: request.body.max_age_seconds,
            idempotencyKey,
            restriction: guard.level,
            signal: toSignal(request.raw),
          },
        );

        await services.repos.idempotency.complete(tenant.id, idempotencyKey, {
          checkId: report.check_id,
          statusCode: 200,
          responseBody: report,
        });

        await services.enqueueCompletionWebhook(tenant.id, report);

        // 200 even when every section is unavailable. Invariant 7.
        return reply.code(200).send(report);
      },
    );

    app.get(
      '/v1/checks/:id',
      {
        preHandler: app.requireTenant,
        schema: {
          summary: 'Fetch a check by id, including sections answered asynchronously since.',
          tags: ['paid'],
          params: CheckParams,
          response: { 200: CheckReport, 401: ErrorResponse, 404: ErrorResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const record = await services.repos.checks.byId(tenant.id, request.params.id);
        if (record === undefined) {
          return reply.code(404).send({
            error: {
              code: 'check_not_found',
              message: 'No such check for this account.',
              request_id: request.id,
            },
          });
        }

        const stored = await services.repos.checks.sections(record.id);
        const sections = Object.fromEntries(
          stored.map((s) => [s.capability, s.section]),
        ) as CheckReport['sections'];

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
            verdict: record.verdict ?? 'undetermined',
            reasons: [],
            sections_unavailable: stored
              .filter((s) => s.outcome === 'unavailable')
              .map((s) => s.capability),
          },
          billing: { credits_charged: record.creditsCharged, breakdown: [] },
          disclaimer: DISCLAIMER,
        };
      },
    );

    /**
     * POST, not GET, despite being a read.
     *
     * An IMEI in a query string is an IMEI in every access log, reverse proxy, browser history
     * and `Referer` header between the caller and us -- none of which we control and none of
     * which honour ADR-0003. The free validator is already a POST for the same reason. REST
     * purity is not worth leaking the one identifier this service exists to protect.
     */
    app.post(
      '/v1/capabilities',
      {
        preHandler: app.requireTenant,
        schema: {
          summary: 'What is checkable for a device and what it costs, before spending anything.',
          tags: ['paid'],
          body: z.object({ imei: z.string().min(1).max(200) }),
          response: { 200: z.any(), 400: ErrorResponse, 401: ErrorResponse },
        },
      },
      async (request, reply) => {
        const parsed = Imei.parse(request.body.imei);
        if (parsed.kind !== 'valid') {
          return reply.code(400).send({
            error: {
              code: 'invalid_imei',
              message: 'That is not a valid IMEI.',
              request_id: request.id,
            },
          });
        }
        const imei = parsed.imei;
        const tac = imei.typeAllocationCode;
        const imeiHash = imei.hmac(services.pepper);

        const capabilities = [];
        for (const capability of Capability.options) {
          const candidates = services.router.candidates(capability, tac);
          const cachedFields = await services.cache.read({
            imeiHash,
            capability,
            fields: [],
            now: new Date(),
          });
          const offline = capability === 'identity.model';
          const derived = capability === 'warranty.status';
          capabilities.push({
            capability,
            available: offline || derived || candidates.length > 0,
            credits: offline || derived ? 0 : (candidates[0]?.service.credits ?? 0),
            ...(candidates.length === 0 && !offline && !derived
              ? { reason: 'provider_no_coverage' as const }
              : {}),
            cached: cachedFields.length > 0,
          });
        }

        return {
          schema_version: SCHEMA_VERSION,
          subject: { imei_masked: imei.masked(), tac, luhn_valid: true },
          capabilities,
          disclaimer: DISCLAIMER,
        };
      },
    );
  };
}

/** Ties the provider calls to the client connection: a hung-up caller stops costing us money. */
function toSignal(raw: { destroyed?: boolean; on?: (e: string, cb: () => void) => unknown }): AbortSignal {
  const controller = new AbortController();
  if (raw.destroyed === true) controller.abort();
  else raw.on?.('aborted', () => controller.abort());
  return controller.signal;
}
