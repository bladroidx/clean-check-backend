import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { Capability } from '@imei-check/contract';
import { ALL_FIELDS, capabilityOf, type CanonicalField } from './fields.js';
import type { CatalogueService } from './types.js';

/**
 * The service catalogue, from checked-in YAML.
 *
 * ADR-0002: capabilities come from a file we control, never from parsing a seller-authored service
 * name. Those names read `"IPHONE GSX FULL INFO (FAST) [24H]"` and change for marketing reasons;
 * routing money on a regex over them is how a price change becomes a negative margin.
 *
 * The catalogue duplicates upstream state and therefore drifts. `drift.ts` reconciles it nightly.
 */

interface RawService {
  service_id?: unknown;
  display_name?: unknown;
  capabilities?: unknown;
  fields?: unknown;
  lexicon?: unknown;
  cost_usd?: unknown;
  credits?: unknown;
  async?: unknown;
  timeout_ms?: unknown;
  applies_to_tac_prefixes?: unknown;
  enabled?: unknown;
  disabled_reason?: unknown;
}

interface RawCatalogue {
  provider_id?: unknown;
  services?: unknown;
}

export class CatalogueError extends Error {
  constructor(message: string) {
    super(`catalogue: ${message}`);
    this.name = 'CatalogueError';
  }
}

export function parseCatalogue(yamlText: string, source: string): CatalogueService[] {
  const doc = load(yamlText) as RawCatalogue | null;
  if (doc === null || typeof doc !== 'object') throw new CatalogueError(`${source} is not a mapping`);

  const providerId = doc.provider_id;
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw new CatalogueError(`${source} has no provider_id`);
  }
  if (!Array.isArray(doc.services)) throw new CatalogueError(`${source} has no services list`);

  return doc.services.map((raw, index) => parseService(raw as RawService, providerId, `${source}[${index}]`));
}

function parseService(raw: RawService, providerId: string, where: string): CatalogueService {
  const serviceId = str(raw.service_id, `${where}.service_id`);
  const capabilities = arr(raw.capabilities, `${where}.capabilities`).map((c) => {
    const parsed = Capability.safeParse(c);
    if (!parsed.success) throw new CatalogueError(`${where}: '${String(c)}' is not a capability`);
    return parsed.data;
  });
  if (capabilities.length === 0) throw new CatalogueError(`${where} declares no capabilities`);

  const fields = arr(raw.fields, `${where}.fields`).map((f) => {
    if (typeof f !== 'string' || !ALL_FIELDS.includes(f as CanonicalField)) {
      throw new CatalogueError(`${where}: '${String(f)}' is not a canonical field`);
    }
    return f as CanonicalField;
  });
  if (fields.length === 0) throw new CatalogueError(`${where} declares no fields`);

  // A service that claims a capability it produces no field for would bill the tenant and then
  // return nothing -- the catalogue is where that is catchable, cheaply, at boot.
  for (const capability of capabilities) {
    if (!fields.some((f) => capabilityOf(f) === capability)) {
      throw new CatalogueError(
        `${where} claims capability '${capability}' but declares no field that produces it`,
      );
    }
  }

  const lexiconId = str(raw.lexicon, `${where}.lexicon`);
  const costUsd = num(raw.cost_usd, `${where}.cost_usd`);
  const credits = num(raw.credits, `${where}.credits`);
  if (!Number.isInteger(credits) || credits < 0) {
    throw new CatalogueError(`${where}.credits must be a non-negative integer`);
  }

  const prefixes = arr(raw.applies_to_tac_prefixes, `${where}.applies_to_tac_prefixes`).map((p) =>
    str(p, `${where}.applies_to_tac_prefixes[]`),
  );
  if (prefixes.length === 0) throw new CatalogueError(`${where} has no applies_to_tac_prefixes`);

  const disabledReason = raw.disabled_reason;

  return {
    serviceId,
    providerId,
    displayName: typeof raw.display_name === 'string' ? raw.display_name : serviceId,
    capabilities,
    fields,
    lexiconId,
    costUsd,
    credits,
    async: raw.async === true,
    timeoutMs: raw.timeout_ms === undefined ? 20_000 : num(raw.timeout_ms, `${where}.timeout_ms`),
    appliesToTacPrefixes: prefixes,
    enabled: raw.enabled !== false,
    ...(typeof disabledReason === 'string' ? { disabledReason } : {}),
  };
}

function str(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CatalogueError(`${where} must be a non-empty string`);
  }
  return value;
}

function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CatalogueError(`${where} must be a number`);
  }
  return value;
}

function arr(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new CatalogueError(`${where} must be a list`);
  return value;
}

export function loadCatalogueFile(path: string): CatalogueService[] {
  return parseCatalogue(readFileSync(path, 'utf8'), path);
}

/** `['*']` matches everything; otherwise a TAC must start with one of the listed prefixes. */
export function coversTac(service: CatalogueService, tac: string): boolean {
  return service.appliesToTacPrefixes.some((p) => p === '*' || tac.startsWith(p));
}
