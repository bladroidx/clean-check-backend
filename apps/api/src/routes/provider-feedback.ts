import { z } from 'zod';
import { ErrorResponse } from '@imei-check/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { settleOrder } from '@imei-check/core';
import type { AppServices } from '../services.js';
import '../lib/raw-body.js';

/**
 * Inbound supplier feedback: `POST /internal/providers/:id/feedback`.
 *
 * This is an unauthenticated POST from the public internet claiming to be a supplier telling us an
 * answer, and it is treated as exactly that. Three gates, all required:
 *
 * 1. **The adapter verifies a signature over the raw bytes.** Not the parsed object -- signing a
 *    re-serialisation checks a signature against something the sender never sent.
 * 2. **The `reference_id` must match an order WE created**, and one that is still open. Without
 *    this, anyone who learns the URL posts `{"status":"success","replay":"...Blacklist: Clean"}`
 *    and launders a stolen handset through our own report.
 * 3. **The order's own capability decides the section**, not anything in the payload. A supplier
 *    (or an impostor) cannot answer a question we did not ask.
 *
 * The response is always a bare 200 or 202 with no detail. Telling a caller *why* their forgery
 * was rejected is free reconnaissance.
 */

const Params = z.object({ id: z.string().min(1).max(64) });
const Ack = z.object({ received: z.boolean() });

export function providerFeedbackRoutes(services: AppServices): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/internal/providers/:id/feedback',
      {
        // Raw body: the signature covers the bytes, so Fastify must not have reserialised them.
        config: { rawBody: true },
        schema: {
          summary: 'Supplier feedback webhook. Signed, matched to an order, and otherwise ignored.',
          tags: ['meta'],
          params: Params,
          response: { 200: Ack, 202: Ack, 400: ErrorResponse, 404: ErrorResponse },
          hide: true,
        },
      },
      async (request, reply) => {
        const provider = services.providers.find((p) => p.id === request.params.id);
        if (provider?.parseWebhook === undefined) {
          return reply.code(404).send({
            error: { code: 'unknown_provider', message: 'No such provider.', request_id: request.id },
          });
        }

        const rawBody = request.rawBody ?? Buffer.alloc(0);

        let parsed;
        try {
          parsed = await provider.parseWebhook({ headers: request.headers, rawBody });
        } catch {
          // Gate 1 failed. No detail: a forger learning which half was wrong is a free hint.
          return reply.code(400).send({
            error: { code: 'invalid_webhook', message: 'Rejected.', request_id: request.id },
          });
        }

        // Gate 2: it must name an order we actually placed, still open.
        const order = await services.repos.orders.byReference(parsed.referenceId);
        if (order === undefined || order.status !== 'pending') {
          return reply.code(202).send({ received: true });
        }

        const tenant = await services.repos.tenants.byId(order.tenantId);
        if (tenant === undefined) return reply.code(202).send({ received: true });

        // Only a FINAL answer settles an order. "Still pending" or "failed" from a webhook is not
        // one: the order stays open for the worker to poll and, if need be, abandon honestly.
        const outcome = parsed.outcome;
        if (outcome.kind !== 'answered' && outcome.kind !== 'rejected') {
          return reply.code(202).send({ received: true });
        }

        // Gate 3: OUR record of what was asked decides the capability -- `settleOrder` builds the
        // section from `order.capability`, never from the payload. It is the same settlement the
        // worker's poll runs (section, derived warranty status, verdict, completion), so the two
        // paths cannot drift.
        await settleOrder(
          {
            repos: services.repos,
            providers: services.providers,
            tacDirectory: app.tacDirectory,
            metrics: services.metrics,
          },
          order,
          outcome,
          new Date(),
        );

        return reply.code(200).send({ received: true });
      },
    );
  };
}
