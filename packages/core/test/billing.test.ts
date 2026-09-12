import { describe, expect, it } from 'vitest';
import { MemoryRepositories } from '../src/db/memory.js';
import { chargeFor, isChargeable } from '../src/billing/pricing.js';
import { cachedPrice } from '../src/cache/store.js';
import { WeakTenantSalt, generateTenantSalt } from '../src/db/tenant-salt.js';

/**
 * The money path.
 *
 * Two of these rules cost real money to honour, and they are the ones that make the four-arm
 * contract trustworthy rather than decorative:
 *
 *   never charge for `unavailable`, and never charge for our own lexicon gap.
 */

describe('the charge matrix', () => {
  it('charges list for an answered pass or fail', () => {
    expect(chargeFor({ section: { outcome: 'pass' }, listCredits: 3, cached: false }).credits).toBe(3);
    expect(chargeFor({ section: { outcome: 'fail' }, listCredits: 3, cached: false }).credits).toBe(3);
  });

  it('never charges for unavailable, whatever the reason', () => {
    for (const reason of ['provider_timeout', 'circuit_open', 'insufficient_credits'] as const) {
      const decision = chargeFor({
        section: { outcome: 'unavailable', reason },
        listCredits: 3,
        cached: false,
      });
      expect(decision.credits).toBe(0);
    }
  });

  /**
   * Our bug, not their usage.
   *
   * Charging here would mean a supplier rewording "Clean" quietly becomes revenue -- a direct
   * incentive not to fix the thing that most endangers the product.
   */
  it('never charges for inconclusive(unrecognised_provider_value)', () => {
    const decision = chargeFor({
      section: { outcome: 'inconclusive', reason: 'unrecognised_provider_value' },
      listCredits: 8,
      cached: false,
    });
    expect(decision.credits).toBe(0);
    expect(decision.reason).toBe('not_charged_our_lexicon_gap');
  });

  it('DOES charge for device_not_found_in_registry, which is a real answer we paid for', () => {
    const decision = chargeFor({
      section: { outcome: 'inconclusive', reason: 'device_not_found_in_registry' },
      listCredits: 3,
      cached: false,
    });
    expect(decision.credits).toBe(3);
  });

  it('charges 20% of list for a cache hit, never zero', () => {
    expect(cachedPrice(10)).toBe(2);
    // Rounded up: a free tier that appears by accident is not a pricing decision.
    expect(cachedPrice(1)).toBe(1);
    expect(chargeFor({ section: { outcome: 'pass' }, listCredits: 10, cached: true }).credits).toBe(2);
  });

  it('a cache hit on an unrecognised value is still free', () => {
    const decision = chargeFor({
      section: { outcome: 'inconclusive', reason: 'unrecognised_provider_value' },
      listCredits: 10,
      cached: true,
    });
    expect(decision.credits).toBe(0);
  });

  it('isChargeable agrees with the matrix', () => {
    expect(isChargeable('pass', undefined)).toBe(true);
    expect(isChargeable('unavailable', 'provider_timeout')).toBe(false);
    expect(isChargeable('inconclusive', 'unrecognised_provider_value')).toBe(false);
    expect(isChargeable('inconclusive', 'device_not_found_in_registry')).toBe(true);
  });
});

describe('tenant salts', () => {
  /**
   * `subject.imei_hash` is HMAC(tenant_salt, digits). A short salt does not pseudonymise a
   * 15-digit space that is enumerable in seconds -- and before this guard, a weakly-salted tenant
   * was a latent 500 on their first paid check rather than an error at creation.
   */
  it('refuses a weak salt at creation, not at first use', async () => {
    const repos = new MemoryRepositories();
    await expect(
      repos.tenants.create({
        id: 't1',
        name: 'T',
        plan: 'free',
        status: 'active',
        imeiSalt: 'short',
      }),
    ).rejects.toThrow(WeakTenantSalt);
  });

  it('generates salts that satisfy its own guard', async () => {
    const repos = new MemoryRepositories();
    await expect(
      repos.tenants.create({
        id: 't1',
        name: 'T',
        plan: 'free',
        status: 'active',
        imeiSalt: generateTenantSalt(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('the credit ledger', () => {
  async function seeded(credits: number) {
    const repos = new MemoryRepositories();
    await repos.tenants.create({
      id: 't1',
      name: 'T',
      plan: 'free',
      status: 'active',
      imeiSalt: generateTenantSalt(),
    });
    await repos.credits.topUp('t1', credits);
    return repos;
  }

  it('reserves, and the balance follows the ledger', async () => {
    const repos = await seeded(100);
    const result = await repos.credits.reserve({
      tenantId: 't1',
      credits: 30,
      checkId: 'chk_1',
      idempotencyKey: 'k1',
    });
    expect(result).toMatchObject({ ok: true, reserved: 30, balanceAfter: 70 });
    expect(await repos.credits.balance('t1')).toBe(70);

    const { drift } = await repos.credits.reconcile('t1');
    expect(drift).toBe(0);
  });

  /** The guarantee the Idempotency-Key header actually makes. */
  it('a retried reserve under the same key does not charge twice', async () => {
    const repos = await seeded(100);
    const args = { tenantId: 't1', credits: 30, checkId: 'chk_1', idempotencyKey: 'k1' };

    await repos.credits.reserve(args);
    const retry = await repos.credits.reserve(args);

    expect(retry).toMatchObject({ ok: true, reserved: 0 });
    expect(await repos.credits.balance('t1')).toBe(70);
  });

  it('refuses a reserve it cannot cover, and charges nothing', async () => {
    const repos = await seeded(10);
    const result = await repos.credits.reserve({
      tenantId: 't1',
      credits: 30,
      checkId: 'chk_1',
      idempotencyKey: 'k1',
    });
    expect(result).toMatchObject({ ok: false, shortfall: 20, balance: 10 });
    expect(await repos.credits.balance('t1')).toBe(10);
  });

  it('refunds as a new positive row: the ledger is append-only', async () => {
    const repos = await seeded(100);
    await repos.credits.reserve({
      tenantId: 't1',
      credits: 30,
      checkId: 'chk_1',
      idempotencyKey: 'k1',
    });
    await repos.credits.refund({
      tenantId: 't1',
      credits: 10,
      checkId: 'chk_1',
      reason: 'settle_refund',
      idempotencyKey: 'settle:chk_1',
    });

    const ledger = await repos.credits.ledger('t1', 10);
    expect(ledger.map((e) => e.delta)).toEqual([10, -30, 100]);
    expect(await repos.credits.balance('t1')).toBe(80);
    expect((await repos.credits.reconcile('t1')).drift).toBe(0);
  });

  it('a duplicated refund is not paid twice', async () => {
    const repos = await seeded(100);
    const args = {
      tenantId: 't1',
      credits: 10,
      checkId: 'chk_1',
      reason: 'settle_refund' as const,
      idempotencyKey: 'settle:chk_1',
    };
    await repos.credits.refund(args);
    await repos.credits.refund(args);
    expect(await repos.credits.balance('t1')).toBe(110);
  });

  it('serialised concurrent reserves cannot overdraw', async () => {
    const repos = await seeded(50);
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        await repos.credits.reserve({
          tenantId: 't1',
          credits: 20,
          checkId: `chk_${i}`,
          idempotencyKey: `k${i}`,
        }),
      );
    }
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await repos.credits.balance('t1')).toBe(10);
    expect((await repos.credits.reconcile('t1')).drift).toBe(0);
  });
});
