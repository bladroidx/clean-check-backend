import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BalanceResponse,
  ErrorResponse,
  SCHEMA_VERSION,
  WebhookRegistered,
  WebhookRegistration,
} from '@imei-check/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { tenantOf } from '../auth/plugin.js';
import type { AppServices } from '../services.js';

/**
 * Balance, ledger and webhook registration.
 *
 * The ledger is exposed because prepaid credits only work as a chargeback defence if the customer
 * can see exactly what they were charged for and why. `reason` is the same vocabulary the billing
 * code uses -- `not_charged_our_lexicon_gap` says, in the customer's own statement, that we did
 * not bill them for our bug.
 */

export function accountRoutes(services: AppServices): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/v1/balance',
      {
        preHandler: app.requireTenant,
        schema: {
          summary: 'Credit balance and recent ledger entries.',
          tags: ['account'],
          response: { 200: BalanceResponse, 401: ErrorResponse },
        },
      },
      async (request) => {
        const tenant = tenantOf(request);
        const [balance, ledger] = await Promise.all([
          services.repos.credits.balance(tenant.id),
          services.repos.credits.ledger(tenant.id, 50),
        ]);
        return {
          schema_version: SCHEMA_VERSION,
          tenant_id: tenant.id,
          credits_remaining: balance,
          recent: ledger.map((entry) => ({
            delta: entry.delta,
            reason: entry.reason,
            check_id: entry.checkId ?? null,
            balance_after: entry.balanceAfter,
            created_at: entry.createdAt.toISOString(),
          })),
        };
      },
    );

    app.post(
      '/v1/webhooks',
      {
        preHandler: app.requireTenant,
        schema: {
          summary: 'Register a webhook for asynchronously completed checks.',
          tags: ['account'],
          body: WebhookRegistration,
          response: { 201: WebhookRegistered, 400: ErrorResponse, 401: ErrorResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);

        // Refuse plaintext and refuse to post a customer's report into their private network.
        // An SSRF check here is cheap; discovering later that we are a request proxy is not.
        const url = new URL(request.body.url);
        if (url.protocol !== 'https:') {
          return reply.code(400).send({
            error: {
              code: 'insecure_webhook_url',
              message: 'A webhook URL must be https. Reports contain device identifiers.',
              request_id: request.id,
            },
          });
        }
        if (isPrivateHost(url.hostname)) {
          return reply.code(400).send({
            error: {
              code: 'private_webhook_url',
              message: 'A webhook URL must be publicly resolvable.',
              request_id: request.id,
            },
          });
        }

        const secret = randomBytes(32).toString('base64url');
        const id = `whe_${randomUUID().replaceAll('-', '')}`;
        await services.repos.webhooks.register({
          id,
          tenantId: tenant.id,
          url: request.body.url,
          secret,
          events: request.body.events,
          active: true,
        });

        // Returned exactly once. We store it because we must sign with it; the customer stores it
        // because they must verify with it.
        return reply.code(201).send({ id, url: request.body.url, events: request.body.events, secret });
      },
    );

    app.get(
      '/metrics',
      { schema: { summary: 'Prometheus metrics.', tags: ['meta'], hide: true } },
      async (_request, reply) => {
        const { refreshCircuitGauge } = await import('../services.js');
        refreshCircuitGauge(services);
        return reply.header('content-type', 'text/plain; version=0.0.4').send(await services.metrics.render());
      },
    );

    void z;
  };
}

const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /\.local$/i,
  /^metadata\./i,
];

export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_PATTERNS.some((p) => p.test(hostname));
}
