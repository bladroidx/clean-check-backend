import {
  DISCLAIMER,
  ErrorResponse,
  SCHEMA_VERSION,
  ValidateRequest,
  ValidateResponse,
  assertSectionInvariants,
  inconclusive,
  pass,
} from '@imei-check/contract';
import { Imei } from '@imei-check/identity';
import { identityCoverage } from '../lib/coverage.js';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * The free, offline tier. No credits, no providers, no network. It is the acquisition funnel and
 * it is also what replaces the three-entry `BundledTacDirectory` stub in the Android app.
 *
 * Note what this endpoint does NOT do: it never claims a phone is clean. Luhn validity and a TAC
 * match say the number is well-formed and the model is plausible. Nothing more.
 */
export const imeiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/imei/validate',
    {
      schema: {
        summary: 'Validate an IMEI and identify the device. Free, offline, no credits.',
        tags: ['free'],
        body: ValidateRequest,
        response: { 200: ValidateResponse, 400: ErrorResponse },
      },
    },
    async (request) => {
      const { imei: raw } = request.body;
      const parsed = Imei.parse(raw);
      const now = new Date();
      const dir = app.tacDirectory;

      if (parsed.kind !== 'valid') {
        // Three failure modes need three different sentences -- "invalid IMEI" tells the user
        // nothing about which of the three problems they have.
        const message =
          parsed.kind === 'checksum_failed'
            ? `The check digit does not match: expected ${parsed.expected}, got ${parsed.given}. ` +
              `One of the digits is wrong.`
            : parsed.kind === 'wrong_length'
              ? `An IMEI is 15 digits; ${parsed.digitsFound} were found.`
              : 'No digits were found in the text supplied.';

        return {
          schema_version: SCHEMA_VERSION,
          subject: {
            imei_masked: parsed.kind === 'checksum_failed' ? parsed.masked : '',
            luhn_valid: false,
          },
          parse: {
            kind: parsed.kind,
            message,
            ...(parsed.kind === 'checksum_failed'
              ? { expected_check_digit: parsed.expected, given_check_digit: parsed.given }
              : {}),
            ...(parsed.kind === 'wrong_length' ? { digits_found: parsed.digitsFound } : {}),
          },
          disclaimer: DISCLAIMER,
        };
      }

      const imei = parsed.imei;
      const entry = dir.lookup(imei.typeAllocationCode);
      const coverage = identityCoverage(dir);

      // An unknown TAC is inconclusive, never a pass. The directory not knowing a model is not
      // evidence that the number is fine.
      const identity = entry
        ? pass({
            capability: 'identity.model',
            checkedAt: now,
            coverage,
            evidence: [
              { type: 'text', label: 'Manufacturer', value: entry.manufacturer },
              { type: 'text', label: 'Model', value: entry.model },
            ],
          })
        : inconclusive({
            capability: 'identity.model',
            checkedAt: now,
            coverage,
            reason: 'device_not_found_in_registry',
            remedy: 'retry_later',
            detail: `TAC ${imei.typeAllocationCode} is not in directory ${dir.version}.`,
            evidence: [{ type: 'text', label: 'Type Allocation Code', value: imei.typeAllocationCode }],
          });

      assertSectionInvariants(identity);

      return {
        schema_version: SCHEMA_VERSION,
        subject: {
          imei_masked: imei.masked(),
          tac: imei.typeAllocationCode,
          luhn_valid: true,
        },
        parse: { kind: 'valid' as const, message: 'The number is well-formed and passes the Luhn check.' },
        identity,
        disclaimer: DISCLAIMER,
      };
    },
  );
};
