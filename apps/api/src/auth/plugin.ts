import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Tenant } from '@imei-check/core';
import { bearerFrom, hashApiKey, looksLikeApiKey } from './keys.js';

/**
 * Bearer API-key authentication.
 *
 * Decorates the request with the tenant rather than the key: nothing downstream ever needs the
 * credential again, and code that cannot reach it cannot log it.
 *
 * Every failure path here returns the SAME body and the same 401. Distinguishing "no such key"
 * from "revoked key" from "expired key" tells an attacker which of their guesses was structurally
 * right, and tells a legitimate operator nothing they cannot get from their dashboard.
 */

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
    apiKeyId?: string;
  }
}

export interface AuthDeps {
  lookup(sha256: string): Promise<{ tenant: Tenant; apiKeyId: string } | undefined>;
  onUsed?(apiKeyId: string, at: Date): Promise<void> | void;
}

const UNAUTHORISED = {
  error: {
    code: 'unauthorised',
    message: 'A valid API key is required. Send it as: Authorization: Bearer imc_live_...',
  },
} as const;

const plugin: FastifyPluginAsync<AuthDeps> = async (app: FastifyInstance, deps: AuthDeps) => {
  app.decorateRequest('tenant', undefined);
  app.decorateRequest('apiKeyId', undefined);

  app.decorate('requireTenant', async (request: FastifyRequest, reply: FastifyReply) => {
    const presented = bearerFrom(request.headers.authorization);

    // Shape-checked before hashing so a pasted JWT or a password does not get digested and
    // compared -- and so the failure is uniform whatever nonsense arrives.
    if (presented === undefined || !looksLikeApiKey(presented)) {
      return reply.code(401).send({ ...UNAUTHORISED, error: { ...UNAUTHORISED.error, request_id: request.id } });
    }

    const found = await deps.lookup(hashApiKey(presented));
    if (found === undefined) {
      return reply.code(401).send({ ...UNAUTHORISED, error: { ...UNAUTHORISED.error, request_id: request.id } });
    }

    if (found.tenant.status !== 'active') {
      return reply.code(403).send({
        error: {
          code: 'tenant_suspended',
          message: 'This account is suspended. Contact support.',
          request_id: request.id,
        },
      });
    }

    request.tenant = found.tenant;
    request.apiKeyId = found.apiKeyId;
    // Fire-and-forget: a last-used timestamp is an operator convenience and must never be the
    // reason a paid check fails.
    void deps.onUsed?.(found.apiKeyId, new Date());
    return undefined;
  });
};

export const authPlugin = fp(plugin, { name: 'imei-auth' });

declare module 'fastify' {
  interface FastifyInstance {
    requireTenant(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  }
}

/** Narrows the optional decoration for handlers that ran behind `requireTenant`. */
export function tenantOf(request: FastifyRequest): Tenant {
  const tenant = request.tenant;
  if (tenant === undefined) {
    throw new Error('tenantOf called on a route that is not behind requireTenant');
  }
  return tenant;
}
