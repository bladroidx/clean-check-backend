import { describe, expect, it } from 'vitest';
import type { CheckReport } from '@imei-check/contract';
import { SENTINEL } from './helpers.js';
import { idempotencyKey, makePaidApp, type PaidHarness } from './paid-helpers.js';

/**
 * ADR-0007: the admin-scoped, audited IMEI reveal route.
 *
 * Scopes are enforced two ways here at once: `checks:write` (the service key) gets 403 on the
 * reveal route, and `imei:reveal` (the admin key) gets 403 on every check route. A key holding
 * BOTH is refused outright at auth -- there is no legitimate reason for one key to be able to run
 * checks and also read back IMEIs, and a key like that is the single leak that defeats the whole
 * split.
 */

function postFree(h: PaidHarness) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/checks',
    headers: { ...h.auth(), 'idempotency-key': idempotencyKey() },
    payload: { imei: SENTINEL },
  });
}

function reveal(h: PaidHarness, checkId: string, headers: Record<string, string>, reason: string) {
  return h.app.inject({
    method: 'POST',
    url: `/v1/admin/checks/${checkId}/imei/reveal`,
    headers,
    payload: { reason },
  });
}

describe('POST /v1/admin/checks/:id/imei/reveal', () => {
  it('service key is refused 403', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    const res = await reveal(h, check.check_id, h.auth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('admin key reveals, audits first, no-store', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    const res = await reveal(h, check.check_id, h.adminAuth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ check_id: check.check_id, imei: SENTINEL });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await h.repos.reveals.forCheck(check.check_id)).toHaveLength(1);
    expect(h.logs.raw()).not.toContain(SENTINEL);
  });

  it('admin key cannot run checks', async () => {
    const h = await makePaidApp();
    // A well-formed idempotency key: the point of this test is the scope gate, not header
    // validation, and IdempotentHeaders (min 8 chars) runs in Fastify's validation phase, BEFORE
    // the preHandler that checks scope -- a too-short key would 400 before ever reaching it.
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { ...h.adminAuth(), 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('audit write failure means nothing is decrypted', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    h.repos.reveals.record = async () => {
      throw new Error('db down');
    };
    const res = await reveal(h, check.check_id, h.adminAuth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SENTINEL);
  });

  it('a pre-ADR-0007 check says not stored, not 500', async () => {
    const h = await makePaidApp();
    await h.repos.checks.insert({
      id: 'chk_old',
      tenantId: 'ten_test',
      imeiHash: 'deadbeef',
      subjectHash: 'deadbeef',
      imeiMasked: '35•••••••••••78',
      tac: undefined,
      requestedCapabilities: ['blacklist.gsma'],
      status: 'complete',
      idempotencyKey: undefined,
      creditsCharged: 0,
      verdict: 'green',
      createdAt: new Date(),
      completedAt: new Date(),
      tier: 'deep',
      imeiEncrypted: undefined,
      imeiKeyVersion: undefined,
    });
    const res = await reveal(h, 'chk_old', h.adminAuth(), 'customer dispute #42 needs device id');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('imei_not_stored');
  });

  it('R15(a): a raw IMEI typed into the reason is scrubbed before it is stored', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    const res = await reveal(h, check.check_id, h.adminAuth(), `reported stolen, confirmed imei ${SENTINEL} by owner`);
    expect(res.statusCode).toBe(200);
    const [row] = await h.repos.reveals.forCheck(check.check_id);
    expect(row?.reason).not.toContain(SENTINEL);
    expect(row?.reason).toContain('[REDACTED-IMEI]');
  });

  it('reason under 10 chars is 400', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    const res = await reveal(h, check.check_id, h.adminAuth(), 'too short');
    expect(res.statusCode).toBe(400);
  });

  it('a key holding both scopes is refused', async () => {
    const h = await makePaidApp();
    const key = await import('../src/auth/keys.js').then((m) => m.generateApiKey(false));
    await h.repos.apiKeys.insert({
      id: 'key_conflict',
      tenantId: 'ten_test',
      prefix: key.prefix,
      keySha256: key.sha256,
      scopes: ['checks:write', 'imei:reveal'],
      revokedAt: undefined,
      expiresAt: undefined,
    });
    const auth = { authorization: `Bearer ${key.plaintext}` };

    const checkRes = await h.app.inject({
      method: 'POST',
      url: '/v1/checks',
      headers: { ...auth, 'idempotency-key': idempotencyKey() },
      payload: { imei: SENTINEL },
    });
    expect(checkRes.statusCode).toBe(403);
    expect(checkRes.json().error.code).toBe('key_scope_conflict');

    const revealRes = await reveal(h, 'chk_whatever', auth, 'customer dispute #42 needs device id');
    expect(revealRes.statusCode).toBe(403);
    expect(revealRes.json().error.code).toBe('key_scope_conflict');
  });

  it('11th reveal in a minute is 429', async () => {
    const h = await makePaidApp();
    const check = (await postFree(h)).json<CheckReport>();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await reveal(h, check.check_id, h.adminAuth(), 'customer dispute #42 needs device id');
    }
    expect(last?.statusCode).toBe(429);
  });
});
