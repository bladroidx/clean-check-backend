import { z } from 'zod';
import {
  CapabilitiesResponse,
  CheckRequest,
  CheckReport,
  Capability,
  DISCLAIMER,
  ErrorResponse,
  SCHEMA_VERSION,
} from '@imei-check/contract';
import { Imei } from '@imei-check/identity';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { OFFLINE_CAPABILITIES, runCheck } from '../orchestrator/run-check.js';
import type { AppServices } from '../services.js';
import { CheckParams, IdempotentHeaders, getCheck, handleCheckPost, toSignal } from './check-shared.js';

/**
 * The free check, and the capabilities preview.
 *
 * `POST /v1/checks` answers from the offline TAC directory only. It is handed no router: "the free
 * check never spends supplier money" holds because the call site cannot, not because a branch
 * remembered not to. A paid capability asked of it is `unavailable(requires_deep_check)` -- the
 * paid route is `POST /v1/deep_checks` (deep-checks.ts).
 */

export function checkRoutes(services: AppServices): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/v1/checks',
      {
        preHandler: [app.requireTenant, app.requireScope('checks:write')],
        schema: {
          summary: 'Free check: offline data only. Never contacts a supplier.',
          tags: ['free'],
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
        const capabilities = request.body.capabilities ?? services.defaultCapabilities;
        return handleCheckPost({
          request,
          reply,
          services,
          tier: 'free',
          imeiText: request.body.imei,
          idempotencyKey: request.headers['idempotency-key'],
          capabilities,
          run: (ctx) =>
            runCheck(
              // No router: the free tier has nothing to buy with.
              {
                repos: services.repos,
                cache: services.cache,
                tacDirectory: app.tacDirectory,
                metrics: services.metrics,
                cipher: services.cipher,
              },
              {
                tier: 'free',
                tenantId: ctx.tenant.id,
                tenantSalt: ctx.tenant.imeiSalt,
                imei: ctx.imei,
                imeiHash: ctx.imei.hmac(services.pepper),
                capabilities,
                maxAgeSeconds: request.body.max_age_seconds,
                idempotencyKey: ctx.idempotencyKey,
                signal: toSignal(reply.raw),
              },
            ),
        });
      },
    );

    app.get(
      '/v1/checks/:id',
      {
        preHandler: [app.requireTenant, app.requireScope('checks:write')],
        schema: {
          summary: 'Fetch a free check by id.',
          tags: ['free'],
          params: CheckParams,
          response: { 200: CheckReport, 401: ErrorResponse, 404: ErrorResponse },
        },
      },
      async (request, reply) => getCheck(request, reply, services, { id: request.params.id, tier: 'free' }),
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
        preHandler: [app.requireTenant, app.requireScope('checks:write')],
        schema: {
          summary: 'What is checkable for a device and what it costs, before spending anything.',
          tags: ['paid'],
          body: z.object({ imei: z.string().min(1).max(200) }),
          response: { 200: CapabilitiesResponse, 400: ErrorResponse, 401: ErrorResponse },
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

        const manufacturer = app.tacDirectory.lookup(tac)?.manufacturer;
        const capabilities = [];
        for (const capability of Capability.options) {
          const candidates = services.router.candidates(capability, tac, manufacturer);
          const cachedFields = await services.cache.read({
            imeiHash,
            capability,
            fields: [],
            now: new Date(),
          });
          const offline = OFFLINE_CAPABILITIES.includes(capability);
          const derived = capability === 'warranty.status';
          // What actually has to be bought: for the derived one, the purchase date it needs. With
          // no service selling that date for this device, warranty status cannot be answered
          // either, and advertising it as available would promise a section that is always
          // `unavailable` (R19).
          const sources = derived
            ? services.router.candidates('warranty.purchase_date', tac, manufacturer)
            : candidates;
          const available = offline || sources.length > 0;
          capabilities.push({
            capability,
            available,
            credits: 0,
            // Derived is still deep: warranty status needs a purchase date, which is bought.
            tier: offline ? ('free' as const) : ('deep' as const),
            cost_usd: offline ? 0 : (sources[0]?.service.costUsd ?? 0),
            ...(!available ? { reason: 'provider_no_coverage' as const } : {}),
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
