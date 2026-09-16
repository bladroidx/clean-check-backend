import { describe, expect, it } from 'vitest';
import { BUILTIN_LEXICONS } from '../src/normalise/lexicons.js';
import { Imei24Provider } from '../src/imei24.js';
import type { CatalogueService } from '../src/types.js';

const service: CatalogueService = {
  serviceId: 'blacklist-global',
  providerId: 'imei24',
  displayName: 'IMEI24 blacklist',
  capabilities: ['blacklist.gsma'],
  fields: ['blacklist.status'],
  lexiconId: 'blacklist',
  costUsd: 0.14,
  credits: 3,
  async: false,
  timeoutMs: 15000,
  appliesToTacPrefixes: ['*'],
  enabled: true,
};

describe('IMEI24 provider', () => {
  it('normalises a JSON IMEI24 response into canonical fields', () => {
    const provider = new Imei24Provider({
      providerId: 'imei24',
      baseUrl: 'https://example.com',
      apiKey: 'secret',
      services: [service],
      lexicons: BUILTIN_LEXICONS,
    });

    const outcome = provider.interpret(
      JSON.stringify({
        status: 'success',
        data: {
          blacklist_status: 'Blacklisted',
          reported_by: 'carrier',
        },
      }),
      service,
    );

    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') throw new Error('unexpected outcome');
    expect(outcome.fields).toContainEqual({
      field: 'blacklist.status',
      value: 'blocked',
      rawLabel: 'Blacklist Status',
    });
  });
});
