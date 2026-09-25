import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogueError, coversTac, loadCatalogueFile, parseCatalogue } from '../src/catalogue.js';
import { lexiconFor } from '../src/normalise/lexicons.js';

/**
 * The catalogue is the one place a pricing or coverage mistake is cheap to catch.
 *
 * It duplicates upstream state deliberately -- routing on a seller-authored service name would
 * mean a marketing rename reroutes money -- so the trade is that it drifts, and every guard here
 * is about making a drifted or malformed catalogue fail at boot rather than at the till.
 */

const CATALOGUE_DIR = join(import.meta.dirname, '..', 'catalogue');

const VALID = `
provider_id: test
services:
  - service_id: "12"
    display_name: Blacklist
    capabilities: [blacklist.gsma]
    fields: [blacklist.status]
    lexicon: blacklist
    cost_usd: 0.12
    credits: 3
    async: false
    timeout_ms: 15000
    applies_to_tac_prefixes: ["*"]
    enabled: true
`;

describe('parsing', () => {
  it('accepts a well-formed catalogue', () => {
    const services = parseCatalogue(VALID, 'test.yaml');
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ serviceId: '12', providerId: 'test', credits: 3 });
  });

  it('rejects an unknown capability rather than ignoring it', () => {
    const yaml = VALID.replace('[blacklist.gsma]', '[blacklist.everything]');
    expect(() => parseCatalogue(yaml, 't')).toThrow(CatalogueError);
  });

  it('rejects a field that is not in the canonical vocabulary', () => {
    const yaml = VALID.replace('[blacklist.status]', '[blacklist.vibes]');
    expect(() => parseCatalogue(yaml, 't')).toThrow(CatalogueError);
  });

  /**
   * A service claiming a capability it produces no field for would bill the tenant and then
   * return nothing. Boot is where that should be found.
   */
  it('rejects a capability with no field that can produce it', () => {
    const yaml = VALID.replace('[blacklist.gsma]', '[blacklist.gsma, lock.activation]');
    expect(() => parseCatalogue(yaml, 't')).toThrow(/declares no field that produces it/);
  });

  it('requires an explicit lexicon binding', () => {
    const yaml = VALID.replace('    lexicon: blacklist\n', '');
    expect(() => parseCatalogue(yaml, 't')).toThrow(CatalogueError);
  });

  it('rejects fractional or negative credits', () => {
    expect(() => parseCatalogue(VALID.replace('credits: 3', 'credits: 2.5'), 't')).toThrow();
    expect(() => parseCatalogue(VALID.replace('credits: 3', 'credits: -1'), 't')).toThrow();
  });

  it('rejects a catalogue with no provider_id, services or TAC prefixes', () => {
    expect(() => parseCatalogue('services: []', 't')).toThrow(/provider_id/);
    expect(() => parseCatalogue('provider_id: x', 't')).toThrow(/services/);
    expect(() =>
      parseCatalogue(VALID.replace('applies_to_tac_prefixes: ["*"]', 'applies_to_tac_prefixes: []'), 't'),
    ).toThrow();
  });

  it('defaults a timeout rather than leaving one unbounded', () => {
    const yaml = VALID.replace('    timeout_ms: 15000\n', '');
    expect(parseCatalogue(yaml, 't')[0]?.timeoutMs).toBe(20_000);
  });
});

describe('TAC coverage', () => {
  const service = parseCatalogue(VALID, 't')[0];

  it('"*" covers everything', () => {
    expect(service && coversTac(service, '35310411')).toBe(true);
  });

  it('a prefix list covers only its prefixes', () => {
    const apple = parseCatalogue(
      VALID.replace('applies_to_tac_prefixes: ["*"]', 'applies_to_tac_prefixes: ["35310411"]'),
      't',
    )[0];
    expect(apple && coversTac(apple, '35310411')).toBe(true);
    expect(apple && coversTac(apple, '35847191')).toBe(false);
  });
});

/**
 * The shipped catalogue, checked as data.
 *
 * These assertions are about the business, not the parser: a service priced below cost, or one
 * whose lexicon does not exist, is a real defect that would otherwise surface as a negative margin
 * or as every value becoming a lexicon miss in production.
 */
describe('the shipped catalogue', () => {
  const files = readdirSync(CATALOGUE_DIR).filter((f) => f.endsWith('.yaml'));
  const services = files.flatMap((f) => loadCatalogueFile(join(CATALOGUE_DIR, f)));

  it('loads every file without error', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(services.length).toBeGreaterThan(0);
  });

  it('binds every service to a lexicon that actually exists', () => {
    for (const service of services) {
      expect(
        lexiconFor(service.providerId, service.lexiconId),
        `service ${service.providerId}/${service.serviceId} names lexicon '${service.lexiconId}'`,
      ).toBeDefined();
    }
  });

  it('costs money to call but never charges the tenant (CLAUDE.md "Money": billing removed)', () => {
    for (const service of services) {
      // Billing was removed: `credit_ledger`/`credit_accounts` are gone, and
      // `CheckReport.billing.credits_charged` is always 0 on the wire, so `credits` is always 0
      // for every service now, paid or not. `cost_usd` is still real spend leaving the business
      // and must stay above zero or a repriced-to-free service would go undetected.
      expect(service.credits, `${service.providerId}/${service.serviceId}`).toBe(0);
      expect(service.costUsd).toBeGreaterThan(0);
    }
  });

  /**
   * ADR-0002 calls two providers per paid capability a launch requirement, to survive one
   * supplier's upstream access being revoked on a Friday. This build is deliberately
   * single-supplier: CLAUDE.md ("The four-arm contract" preamble) names imei24 as *the* sole paid
   * supplier for this phase, served by the pre-existing `DhruLegacyProvider`. Skipped rather than
   * deleted or weakened, so the ADR-0002 gate reactivates the moment a second provider's catalogue
   * lands instead of silently staying green forever.
   */
  it.skip('has at least two providers for every paid capability (ADR-0002; deferred while imei24 is the sole supplier)', () => {
    const byCapability = new Map<string, Set<string>>();
    for (const service of services) {
      for (const capability of service.capabilities) {
        const providers = byCapability.get(capability) ?? new Set();
        providers.add(service.providerId);
        byCapability.set(capability, providers);
      }
    }
    const singleSourced = [...byCapability.entries()]
      .filter(([, providers]) => providers.size < 2)
      .map(([capability]) => capability);

    expect(
      singleSourced,
      `single-sourced capabilities: ${singleSourced.join(', ')}. Add a second supplier before launch.`,
    ).toEqual([]);
  });

  it('never claims an Apple-only service covers every TAC', () => {
    for (const service of services) {
      const appleOnly = service.capabilities.includes('lock.activation');
      if (appleOnly) {
        expect(
          service.appliesToTacPrefixes,
          `${service.providerId}/${service.serviceId} claims activation lock for all TACs`,
        ).not.toContain('*');
      }
    }
  });
});
