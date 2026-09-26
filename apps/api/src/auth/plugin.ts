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
 *
 * Routes run it as an `onRequest` hook, never `preHandler`: Fastify validates headers, params and
 * body between the two, so a `preHandler` guard would answer a keyless caller with a 400 that
 * describes the request schema. It needs nothing but the Authorization header.
 */

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: Tenant;
    apiKeyId?: string;
    apiKeyScopes?: readonly string[];
  }
}

export interface AuthDeps {
  lookup(
    sha256: string,
  ): Promise<{ tenant: Tenant; apiKeyId: string; scopes: readonly string[] } | undefined>;
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
  app.decorateRequest('apiKeyScopes', undefined);

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

    // ADR-0007: `checks:write` and `imei:reveal` are mutually exclusive. One leaked key that can
    // both run checks AND read back IMEIs defeats the entire point of splitting the scopes -- so a
    // key minted with both (an operator mistake, since the seed scripts never do this) is refused
    // outright rather than allowed to exercise whichever scope a given route asks for.
    if (found.scopes.includes('checks:write') && found.scopes.includes('imei:reveal')) {
      return reply.code(403).send({
        error: {
          code: 'key_scope_conflict',
          message: "This key holds both 'checks:write' and 'imei:reveal'. Split it into two keys.",
          request_id: request.id,
        },
      });
    }

    request.tenant = found.tenant;
    request.apiKeyId = found.apiKeyId;
    request.apiKeyScopes = found.scopes;
    // Fire-and-forget: a last-used timestamp is an operator convenience and must never be the
    // reason a paid check fails.
    void deps.onUsed?.(found.apiKeyId, new Date());
    return undefined;
  });

  app.decorate('requireScope', (scope: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(request.apiKeyScopes ?? []).includes(scope)) {
      return reply.code(403).send({
        error: {
          code: 'insufficient_scope',
          message: `This key lacks the '${scope}' scope.`,
          request_id: request.id,
        },
      });
    }
    return undefined;
  });
};

export const authPlugin = fp(plugin, { name: 'imei-auth' });

declare module 'fastify' {
  interface FastifyInstance {
    requireTenant(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
    requireScope(scope: string): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
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

/** Narrows the optional decoration for handlers that ran behind `requireTenant`. */
export function apiKeyIdOf(request: FastifyRequest): string {
  const apiKeyId = request.apiKeyId;
  if (apiKeyId === undefined) {
    throw new Error('apiKeyIdOf called on a route that is not behind requireTenant');
  }
  return apiKeyId;
}
