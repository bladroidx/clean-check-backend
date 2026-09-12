import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DhruRestProvider, WebhookRejected } from '../src/dhru/rest.js';
import { BUILTIN_LEXICONS } from '../src/normalise/lexicons.js';
import type { CatalogueService } from '../src/types.js';

/**
 * `parseWebhook`, branch by branch.
 *
 * This function decides whether an unauthenticated POST from the internet gets to change a paid
 * report. Every rejection path is worth a test, because the failure mode of a missed one is that
 * somebody posts "Blacklist Status: Clean" about a stolen handset and we publish it.
 */

const SECRET = 'shared-webhook-secret';

const service: CatalogueService = {
  serviceId: 'gsx',
  providerId: 'beta',
  displayName: 'gsx',
  capabilities: ['blacklist.gsma'],
  fields: ['blacklist.status'],
  lexiconId: 'blacklist',
  costUsd: 0.6,
  credits: 8,
  async: true,
  timeoutMs: 30_000,
  appliesToTacPrefixes: ['*'],
  enabled: true,
};

const provider = new DhruRestProvider({
  providerId: 'beta',
  baseUrl: 'https://example.invalid',
  token: 't',
  webhookSecret: SECRET,
  services: [service],
  lexicons: BUILTIN_LEXICONS,
});

function post(payload: unknown, opts: { secret?: string; header?: string } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature =
    opts.header ?? createHmac('sha256', opts.secret ?? SECRET).update(body).digest('hex');
  return provider.parseWebhook({
    headers: { 'x-dhru-signature': signature },
    rawBody: Buffer.from(body, 'utf8'),
  });
}

describe('parseWebhook', () => {
  it('accepts and normalises a signed success', async () => {
    const parsed = await post({
      reference_id: 'ref-1',
      status: 'success',
      replay: Buffer.from('Blacklist Status: Blacklisted').toString('base64'),
    });
    expect(parsed.referenceId).toBe('ref-1');
    expect(parsed.outcome.kind).toBe('answered');
    if (parsed.outcome.kind === 'answered') {
      expect(parsed.outcome.fields[0]).toMatchObject({ field: 'blacklist.status', value: 'blocked' });
    }
  });

  it('carries a rejection through as a rejection', async () => {
    const parsed = await post({
      reference_id: 'ref-2',
      status: 'rejected',
      message: 'Device not supported',
    });
    expect(parsed.outcome.kind).toBe('rejected');
  });

  it('rejects a missing signature header', async () => {
    await expect(
      provider.parseWebhook({ headers: {}, rawBody: Buffer.from('{}') }),
    ).rejects.toThrow(WebhookRejected);
  });

  it('rejects a signature of the wrong length without leaking timing', async () => {
    await expect(post({ reference_id: 'r' }, { header: 'abc' })).rejects.toThrow(WebhookRejected);
  });

  it('rejects a body that is not JSON', async () => {
    await expect(post('not json at all')).rejects.toThrow(/not JSON/);
  });

  it('rejects a payload with no reference_id', async () => {
    await expect(post({ status: 'success', replay: '' })).rejects.toThrow(/reference_id/);
  });

  it('rejects a success with no replay payload', async () => {
    await expect(post({ reference_id: 'r', status: 'success' })).rejects.toThrow(/replay/);
  });

  it('accepts an array header, as a proxy may produce', async () => {
    const body = JSON.stringify({
      reference_id: 'ref-3',
      status: 'success',
      replay: Buffer.from('Blacklist Status: Clean').toString('base64'),
    });
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    const parsed = await provider.parseWebhook({
      headers: { 'x-dhru-signature': [signature, 'other'] },
      rawBody: Buffer.from(body),
    });
    expect(parsed.referenceId).toBe('ref-3');
  });

  it('scrubs an IMEI echoed inside the replay payload', async () => {
    const parsed = await post({
      reference_id: 'ref-4',
      status: 'success',
      replay: Buffer.from('IMEI: 353104112345676\nBlacklist Status: Clean').toString('base64'),
    });
    expect(JSON.stringify(parsed)).not.toContain('353104112345676');
  });
});
