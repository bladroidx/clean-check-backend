import { z } from 'zod';
import { ErrorResponse, SCHEMA_VERSION } from '@imei-check/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * Single TAC lookup. Free, but hard rate-limited.
 *
 * There is deliberately no list, no wildcard and no pagination here. Serving individual facts is
 * not distributing the compilation; serving the compilation is, and that would hard-trigger
 * CC-BY-SA ShareAlike across our whole dataset. An unlimited single-lookup endpoint is a bulk
 * export with extra steps, so the limit is part of the licensing posture, not just abuse control.
 * See docs/adr/0005-tac-data-licensing.md.
 */

const Params = z.object({ tac: z.string().regex(/^\d{8}$/, 'A TAC is exactly 8 digits') });

const TacResponse = z.object({
  schema_version: z.string(),
  tac: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  marketing_name: z.string().optional(),
  source_version: z.string(),
  attribution: z.string().optional(),
});

export const tacRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/v1/tac/:tac',
    {
      schema: {
        summary: 'Look up one Type Allocation Code. Free, single lookups only.',
        tags: ['free'],
        params: Params,
        response: { 200: TacResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const entry = app.tacDirectory.lookup(request.params.tac);
      if (!entry) {
        return reply.code(404).send({
          error: {
            code: 'tac_not_found',
            message: `TAC ${request.params.tac} is not in directory ${app.tacDirectory.version}.`,
            request_id: request.id,
          },
        });
      }
      return {
        schema_version: SCHEMA_VERSION,
        tac: request.params.tac,
        manufacturer: entry.manufacturer,
        model: entry.model,
        ...(entry.marketingName ? { marketing_name: entry.marketingName } : {}),
        source_version: app.tacDirectory.version,
        ...(app.tacDirectory.attribution ? { attribution: app.tacDirectory.attribution } : {}),
      };
    },
  );

  app.get(
    '/v1/attributions',
    { schema: { summary: 'Data source attributions.', tags: ['meta'] } },
    async () => ({
      sources: [
        {
          name: 'TAC directory',
          version: app.tacDirectory.version,
          entries: app.tacDirectory.size,
          attribution: app.tacDirectory.attribution ?? null,
        },
      ],
    }),
  );
};
