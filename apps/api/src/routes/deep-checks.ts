import { CheckReport, CheckRequest, ErrorResponse } from '@imei-check/contract';
import type { TacDirectory } from '@imei-check/identity';
import { pollOrders } from '@imei-check/core';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { OFFLINE_CAPABILITIES, runCheck } from '../orchestrator/run-check.js';
import type { AppServices } from '../services.js';
import {
  CheckParams,
  IdempotentHeaders,
  getCheck,
  handleCheckPost,
  reportFromRecord,
  toSignal,
} from './check-shared.js';

/**
 * The paid check.
 *
 * Buys the requested capabilities from the supplier (fewest services, attaching to any order
 * already open for the device), then waits up to `deepWaitMs` -- a TOTAL budget measured from the
 * start of the request, not from when the order was placed -- for standard orders to answer. What
 * is still pending when the window closes is `inconclusive(awaiting_provider)`, and the caller
 * polls `GET /v1/deep_checks/:id`, which reads our database and never calls the supplier.
 *
 * The window has to stay below every caller's timeout along the chain. A report that arrives after
 * the caller gave up is money spent on an answer nobody received.
 */

export function deepCheckRoutes(services: AppServices): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/v1/deep_checks',
      {
        preHandler: app.requireTenant,
        schema: {
          summary: 'Paid check via imei24. Waits up to DEEP_CHECK_WAIT_MS, then hand off to GET.',
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
        const requested = request.body.capabilities ?? services.deepDefaultCapabilities;
        // Deep reports are paid sections only; the client merges them with the free report. A
        // 400 rather than a silent drop, so a client that asked for identity here learns where it
        // lives instead of rendering a report with a hole in it.
        if (requested.some((c) => OFFLINE_CAPABILITIES.includes(c))) {
          return reply.code(400).send({
            error: {
              code: 'capability_not_in_tier',
              message:
                'identity.model is answered by POST /v1/checks; deep checks return paid sections only.',
              request_id: request.id,
            },
          });
        }

        const startedAt = Date.now();
        return handleCheckPost({
          request,
          reply,
          services,
          tier: 'deep',
          imeiText: request.body.imei,
          idempotencyKey: request.headers['idempotency-key'],
          capabilities: requested,
          run: async (ctx) => {
            const first = await runCheck(
              {
                repos: services.repos,
                router: services.router,
                cache: services.cache,
                tacDirectory: app.tacDirectory,
                metrics: services.metrics,
              },
              {
                tier: 'deep',
                tenantId: ctx.tenant.id,
                tenantSalt: ctx.tenant.imeiSalt,
                imei: ctx.imei,
                imeiHash: ctx.imei.hmac(services.pepper),
                capabilities: requested,
                maxAgeSeconds: request.body.max_age_seconds,
                idempotencyKey: ctx.idempotencyKey,
                signal: toSignal(request.raw),
              },
            );
            if (first.status !== 'partial') return first;

            await waitForOrders(
              services,
              app.tacDirectory,
              first.check_id,
              startedAt + services.deepWaitMs,
              services.pollIntervalMs,
            );
            const record = await services.repos.checks.byId(ctx.tenant.id, first.check_id, 'deep');
            return record === undefined ? first : reportFromRecord(services, record);
          },
        });
      },
    );

    app.get(
      '/v1/deep_checks/:id',
      {
        preHandler: app.requireTenant,
        schema: {
          summary: 'Fetch a deep check by id, including sections answered since. Never calls a supplier.',
          tags: ['paid'],
          params: CheckParams,
          response: { 200: CheckReport, 401: ErrorResponse, 404: ErrorResponse },
        },
      },
      async (request, reply) => getCheck(request, reply, services, { id: request.params.id, tier: 'deep' }),
    );
  };
}

/**
 * Polls this check's open orders until they settle or `deadline` (epoch ms) passes.
 *
 * Settlement is the same `pollOrders` the worker runs, so the section, cache write and verdict
 * recompute cannot drift between the two clocks. Polls go through the guarded providers and so
 * take the supplier's one-job lock like every other call.
 */
async function waitForOrders(
  services: AppServices,
  tacDirectory: TacDirectory,
  checkId: string,
  deadline: number,
  intervalMs: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const open = await services.repos.orders.openForCheck(checkId);
    if (open.length === 0) return;
    const summary = await pollOrders(
      { repos: services.repos, providers: services.providers, tacDirectory, metrics: services.metrics },
      open,
    );
    if (summary.stillPending === 0) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}
