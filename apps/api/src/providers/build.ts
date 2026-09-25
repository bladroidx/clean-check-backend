import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalogueFile, type CatalogueService, type Provider } from '@imei-check/providers';
import type { Config } from '../config.js';

/**
 * Builds the provider set from configuration.
 *
 * A provider whose credentials are absent is simply **not built**. It is not built-and-broken,
 * because a provider that exists but always fails would open its own circuit, occupy a slot in the
 * router's candidate list and turn every section into `unavailable(provider_not_configured)` --
 * whereas not building it lets the next provider answer, or lets the capability be honestly
 * reported as having no coverage at all.
 *
 * Running with zero providers is a supported mode, not a misconfiguration: it is exactly the M0
 * free tier, and it costs nothing to operate.
 */

export interface BuiltProviders {
  readonly providers: Provider[];
  readonly catalogue: readonly CatalogueService[];
  /** Named so `/readyz` and the startup log can say which suppliers are absent and why. */
  readonly skipped: ReadonlyArray<{ providerId: string; reason: string }>;
}

export function buildProviders(config: Config): BuiltProviders {
  const providers: Provider[] = [];
  const skipped: Array<{ providerId: string; reason: string }> = [];
  const catalogue: CatalogueService[] = [];

  const byProvider = loadCatalogues(config.PROVIDER_CATALOGUE_DIR);
  for (const services of byProvider.values()) catalogue.push(...services);

  // Alpha, beta and the hand-guessed imei24 REST adapter are gone (Task 3). imei24
  // (pro.imei24.com) actually speaks the DHRU legacy protocol, so it is wired up here as a
  // `DhruLegacyProvider` in Task 6, alongside the rest of this function's rewrite.

  return { providers, catalogue, skipped };
}

export function loadCatalogues(dir: string): Map<string, CatalogueService[]> {
  const byProvider = new Map<string, CatalogueService[]>();
  if (!existsSync(dir)) return byProvider;

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    for (const service of loadCatalogueFile(join(dir, file))) {
      const existing = byProvider.get(service.providerId);
      if (existing === undefined) byProvider.set(service.providerId, [service]);
      else existing.push(service);
    }
  }
  return byProvider;
}

/** The public feedback URL an async supplier POSTs its result to. */
export function feedbackUrlFor(config: Config, providerId: string): string | undefined {
  if (config.PUBLIC_BASE_URL === undefined) return undefined;
  return `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/internal/providers/${providerId}/feedback`;
}
