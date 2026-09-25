import { z } from 'zod';
import { ErrorResponse } from '@imei-check/contract';
import { revealImei } from '@imei-check/core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { apiKeyIdOf, tenantOf } from '../auth/plugin.js';
import type { AppServices } from '../services.js';

/**
 * ADR-0007: the ONLY way an already-stored check's IMEI comes back out.
 *
 * Gated by `imei:reveal`, a scope that `requireTenant` refuses to coexist with `checks:write` on
 * the same key -- so the service key (check-this-phone's backend) can never reach this route no
 * matter what a caller sends. Rate-limited per key, not per tenant: there is exactly one tenant,
 * but the limit exists to bound one leaked key, not to share a budget across keys.
 *
 * `revealImei` (packages/core) writes the audit row BEFORE decrypting and does not swallow that
 * write's failure -- so if the database is unreachable for the audit insert, the request below
 * throws and the caller gets a generic 500, having decrypted nothing.
 */

const Params = z.object({ id: z.string().min(3).max(80) });
const RevealBody = z.object({
  reason: z
    .string()
    .trim()
    .min(10, 'reason must be at least 10 characters')
    .max(500),
});
const RevealResponse = z.object({ check_id: z.string(), imei: z.string() });

const REVEAL_LIMIT = { capacity: 10, refillPerSecond: 10 / 60 } as const;

export function adminRoutes(services: AppServices): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/v1/admin/checks/:id/imei/reveal',
      {
        preHandler: [app.requireTenant, app.requireScope('imei:reveal')],
        schema: {
          summary: 'Reveal a stored check\'s IMEI. Audited and rate-limited; imei:reveal scope only.',
          tags: ['admin'],
          params: Params,
          body: RevealBody,
          response: {
            200: RevealResponse,
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
            429: ErrorResponse,
            500: ErrorResponse,
          },
          hide: true,
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const apiKeyId = apiKeyIdOf(request);

        const rate = services.limiter.take(`reveal:${apiKeyId}`, REVEAL_LIMIT);
        if (!rate.allowed) {
          return reply
            .code(429)
            .header('retry-after', String(rate.retryAfterSeconds))
            .send({
              error: {
                code: 'rate_limited',
                message: `Too many reveals. Retry in ${rate.retryAfterSeconds}s.`,
                request_id: request.id,
              },
            });
        }

        let result;
        try {
          result = await revealImei(
            { repos: services.repos, cipher: services.cipher },
            {
              tenantId: tenant.id,
              checkId: request.params.id,
              actor: `api:${apiKeyId}`,
              reason: request.body.reason,
            },
          );
        } catch {
          // The audit write (or the decrypt itself) failed. Generic and digit-free -- and per
          // ADR-0007, a failed audit write means nothing was decrypted; the audit row it managed
          // to write (if any) stands as the record of the attempt.
          return reply.code(500).send({
            error: {
              code: 'internal_error',
              message: 'The IMEI could not be revealed.',
              request_id: request.id,
            },
          });
        }

        if (result.kind === 'not_found') {
          return reply.code(404).send({
            error: {
              code: 'check_not_found',
              message: 'No such check for this account.',
              request_id: request.id,
            },
          });
        }
        if (result.kind === 'not_stored') {
          return reply.code(404).send({
            error: {
              code: 'imei_not_stored',
              message: 'This check predates encrypted IMEI storage (ADR-0007).',
              request_id: request.id,
            },
          });
        }

        // no-store: this response carries the one thing that must never be cached, replayed from
        // a shared proxy, or sit in a browser's back/forward cache.
        return reply
          .header('cache-control', 'no-store')
          .code(200)
          .send({ check_id: request.params.id, imei: result.imei });
      },
    );
  };
}
